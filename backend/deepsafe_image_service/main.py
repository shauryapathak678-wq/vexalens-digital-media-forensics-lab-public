from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import logging
import math
import os
import time
from datetime import datetime, timezone
from io import BytesIO
from typing import Any, Literal

import httpx
from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from PIL import Image, UnidentifiedImageError

logger = logging.getLogger("vexalens.deepsafe")
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))

MAX_IMAGE_BYTES = int(os.getenv("DEEPSAFE_MAX_IMAGE_BYTES", str(25 * 1024 * 1024)))
MAX_IMAGE_PIXELS = int(os.getenv("DEEPSAFE_MAX_IMAGE_PIXELS", "30000000"))
MODEL_TIMEOUT_SECONDS = min(
    90.0,
    max(1.0, float(os.getenv("DEEPSAFE_MODEL_TIMEOUT_SECONDS", "90"))),
)
MODEL_CONFIG: dict[str, dict[str, str]] = {
    "npr_deepfakedetection": {
        "name": "NPR Deepfake Detection",
        "version": "1.1.0",
        "url": os.getenv("DEEPSAFE_NPR_PREDICT_URL", "").strip(),
    },
    "universalfakedetect": {
        "name": "UniversalFakeDetect",
        "version": "1.1.0",
        "url": os.getenv("DEEPSAFE_UFD_PREDICT_URL", "").strip(),
    },
}

SCORE_MEANING = (
    "Sigmoid-transformed fake-class logit; higher values indicate a stronger "
    "fake-class output. It is uncalibrated and is not a probability of image origin."
)
SCORE_TYPE = "uncalibrated_sigmoid_fake_class_logit"
FUSION_METHOD = (
    "No aggregate verdict is computed. NPR and UniversalFakeDetect scores remain "
    "independent; no decision threshold has been validated for this use."
)
bearer_scheme = HTTPBearer(auto_error=False)
active_hashes: set[str] = set()
active_hashes_lock = asyncio.Lock()
analysis_semaphore = asyncio.Semaphore(1)

app = FastAPI(
    title="VexaLens DeepSafe Image Inference",
    version="1.1.0",
    docs_url=None,
    redoc_url=None,
)


async def require_service_token(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
) -> None:
    expected = os.getenv("DEEPSAFE_IMAGE_SERVICE_TOKEN", "").strip()
    if len(expected) < 32:
        raise HTTPException(
            status_code=503,
            detail="The DeepSafe inference service token is not configured securely.",
        )
    if (
        credentials is None
        or credentials.scheme.lower() != "bearer"
        or not hmac.compare_digest(credentials.credentials, expected)
    ):
        raise HTTPException(status_code=401, detail="A valid VexaLens service token is required.")


def decode_and_inspect_image(image_bytes: bytes, content_type: str | None) -> dict[str, Any]:
    if not image_bytes:
        raise HTTPException(status_code=400, detail="The image upload is empty.")
    if len(image_bytes) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="The image exceeds the 25 MB analysis limit.")

    try:
        with Image.open(BytesIO(image_bytes)) as image:
            image_format = image.format
            width, height = image.size
            if image_format not in {"JPEG", "PNG"}:
                raise HTTPException(
                    status_code=415,
                    detail="DeepSafe image analysis supports JPEG and PNG files only.",
                )
            if width <= 0 or height <= 0 or width * height > MAX_IMAGE_PIXELS:
                raise HTTPException(
                    status_code=413,
                    detail="The image exceeds the 30-megapixel analysis limit.",
                )
            image.verify()
    except HTTPException:
        raise
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise HTTPException(status_code=400, detail="The uploaded file is not a valid image.") from exc

    mime_type = "image/jpeg" if image_format == "JPEG" else "image/png"
    supplied_type = (content_type or "").split(";", 1)[0].strip().lower()
    if supplied_type and supplied_type != mime_type:
        raise HTTPException(
            status_code=415,
            detail="The declared image format does not match the uploaded image data.",
        )
    return {
        "mime_type": mime_type,
        "format": image_format,
        "width": width,
        "height": height,
        "sha256": hashlib.sha256(image_bytes).hexdigest(),
    }


def normalize_model_result(
    model_id: str,
    raw_output: Any,
) -> dict[str, Any]:
    config = MODEL_CONFIG[model_id]
    normalized: dict[str, Any] = {
        "model_id": model_id,
        "model_name": config["name"],
        "model_version": config["version"],
        "status": "failed",
        "score": None,
        "raw_logit": None,
        "score_type": SCORE_TYPE,
        "score_meaning": SCORE_MEANING,
        "threshold": None,
        "classification": None,
        "inference_time_seconds": None,
        "raw_output": raw_output,
        "error": None,
    }

    if not isinstance(raw_output, dict):
        normalized["error"] = "The model returned an invalid response."
        return normalized
    if raw_output.get("error"):
        normalized["error"] = "The model service reported an inference error."
        return normalized

    score = raw_output.get("probability")
    raw_logit = raw_output.get("raw_logit")
    inference_time = raw_output.get("inference_time")
    if (
        isinstance(score, bool)
        or not isinstance(score, (float, int))
        or not math.isfinite(float(score))
        or not 0.0 <= float(score) <= 1.0
        or (
            raw_logit is not None
            and (
                isinstance(raw_logit, bool)
                or not isinstance(raw_logit, (float, int))
                or not math.isfinite(float(raw_logit))
            )
        )
    ):
        normalized["error"] = "The model returned an invalid fake-class score or logit."
        return normalized

    score_value = float(score)
    logit_value = float(raw_logit) if raw_logit is not None else None
    if logit_value is not None:
        sigmoid_score = (
            1.0 / (1.0 + math.exp(-logit_value))
            if logit_value >= 0
            else math.exp(logit_value) / (1.0 + math.exp(logit_value))
        )
        if not math.isclose(score_value, sigmoid_score, rel_tol=1e-5, abs_tol=1e-6):
            normalized["error"] = "The model score did not match its reported logit."
            return normalized

    normalized.update(
        {
            "status": "completed",
            "score": score_value,
            "raw_logit": logit_value,
            "inference_time_seconds": (
                float(inference_time)
                if isinstance(inference_time, (float, int))
                and not isinstance(inference_time, bool)
                and math.isfinite(float(inference_time))
                and float(inference_time) >= 0
                else None
            ),
        }
    )
    return normalized


def failed_model_result(
    model_id: str,
    status: Literal["failed", "not_configured", "unavailable"],
    message: str,
    raw_output: dict[str, Any],
) -> dict[str, Any]:
    result = normalize_model_result(model_id, raw_output)
    result["status"] = status
    result["error"] = message
    return result


def build_ensemble(model_results: dict[str, dict[str, Any]]) -> dict[str, Any]:
    completed = [
        result
        for result in model_results.values()
        if result["status"] == "completed"
    ]

    if not completed:
        assessment = "analysis_failed"
        observations = [
            "Neither DeepSafe detector returned a usable result; image analysis failed."
        ]
    elif len(completed) < len(MODEL_CONFIG):
        assessment = "inconclusive"
        observations = [
            "At least one detector was unavailable; the available per-model score is not an overall assessment."
        ]
    else:
        assessment = "inconclusive"
        observations = [
            "Both per-model scores are available, but no validated decision threshold or combined "
            "assessment is provided for this use."
        ]

    return {
        "method": FUSION_METHOD,
        "assessment": assessment,
        "fake_votes": None,
        "total_votes": None,
        "score": None,
        "observations": observations,
    }


async def query_model(
    client: httpx.AsyncClient,
    model_id: str,
    encoded_image: str,
) -> dict[str, Any]:
    endpoint = MODEL_CONFIG[model_id]["url"]
    if not endpoint:
        return failed_model_result(
            model_id,
            "not_configured",
            "The model endpoint is not configured.",
            {"error": "The model endpoint is not configured."},
        )

    try:
        response = await client.post(
            endpoint,
            json={"image_data": encoded_image},
        )
        response.raise_for_status()
        raw_output: Any = response.json()
    except httpx.TimeoutException:
        return failed_model_result(
            model_id,
            "unavailable",
            "The model service timed out.",
            {"error": "timeout"},
        )
    except httpx.HTTPStatusError as exc:
        logger.warning(
            "DeepSafe model %s returned HTTP %s",
            model_id,
            exc.response.status_code,
        )
        return failed_model_result(
            model_id,
            "unavailable" if exc.response.status_code >= 500 else "failed",
            f"The model service returned HTTP {exc.response.status_code}.",
            {"error": f"HTTP {exc.response.status_code}"},
        )
    except (httpx.RequestError, ValueError) as exc:
        logger.warning("DeepSafe model %s request failed: %s", model_id, exc)
        return failed_model_result(
            model_id,
            "unavailable",
            "The model service is unavailable or returned invalid JSON.",
            {"error": "unavailable"},
        )

    return normalize_model_result(model_id, raw_output)


async def query_model_with_deadline(
    client: httpx.AsyncClient,
    model_id: str,
    encoded_image: str,
) -> dict[str, Any]:
    try:
        return await asyncio.wait_for(
            query_model(client, model_id, encoded_image),
            timeout=MODEL_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        return failed_model_result(
            model_id,
            "unavailable",
            f"The model exceeded the {MODEL_TIMEOUT_SECONDS:g}-second analysis limit.",
            {"error": "timeout"},
        )


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/v1/health", dependencies=[Depends(require_service_token)])
async def service_health() -> dict[str, Any]:
    models: dict[str, dict[str, Any]] = {}
    async with httpx.AsyncClient(timeout=5.0) as client:
        for model_id, config in MODEL_CONFIG.items():
            endpoint = config["url"]
            if not endpoint:
                models[model_id] = {
                    "status": "not_configured",
                    "model_name": config["name"],
                    "model_version": config["version"],
                    "loaded": False,
                }
                continue
            health_url = endpoint.rsplit("/", 1)[0] + "/health"
            try:
                response = await client.get(health_url)
                response.raise_for_status()
                health = response.json()
                if not isinstance(health, dict) or health.get("status") != "healthy":
                    raise ValueError("The model health endpoint is not healthy.")
                models[model_id] = {
                    "status": "available",
                    "model_name": config["name"],
                    "model_version": config["version"],
                    "loaded": health.get("model_loaded") is True,
                }
            except (httpx.RequestError, httpx.HTTPStatusError, ValueError) as exc:
                logger.info("DeepSafe health check failed for %s: %s", model_id, exc)
                models[model_id] = {
                    "status": "unavailable",
                    "model_name": config["name"],
                    "model_version": config["version"],
                    "loaded": False,
                }
    return {
        "available": all(model["status"] == "available" for model in models.values()),
        "models": models,
    }


@app.post("/v1/analyze", dependencies=[Depends(require_service_token)])
async def analyze_image(file: UploadFile = File(...)) -> dict[str, Any]:
    image_bytes = await file.read(MAX_IMAGE_BYTES + 1)
    image_info = decode_and_inspect_image(image_bytes, file.content_type)
    image_sha256 = image_info["sha256"]

    async with active_hashes_lock:
        if image_sha256 in active_hashes:
            raise HTTPException(
                status_code=409,
                detail="An analysis for this evidence image is already running.",
            )
        active_hashes.add(image_sha256)

    acquired = False
    try:
        try:
            await asyncio.wait_for(analysis_semaphore.acquire(), timeout=0.01)
            acquired = True
        except asyncio.TimeoutError as exc:
            raise HTTPException(
                status_code=429,
                detail="DeepSafe is processing another image. Retry when that analysis finishes.",
            ) from exc

        encoded_image = base64.b64encode(image_bytes).decode("ascii")
        inference_started = time.monotonic()
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(MODEL_TIMEOUT_SECONDS)
        ) as client:
            model_ids = tuple(MODEL_CONFIG)
            model_outputs = await asyncio.gather(
                *(query_model_with_deadline(client, model_id, encoded_image) for model_id in model_ids)
            )
            model_results = dict(zip(model_ids, model_outputs))
        ensemble = build_ensemble(model_results)
        completed_model_count = sum(
            result["status"] == "completed" for result in model_results.values()
        )
        errors = [
            f'{result["model_name"]}: {result["error"]}'
            for result in model_results.values()
            if result["status"] != "completed" and result["error"]
        ]
        return {
            "provider": "DeepSafe",
            "provider_revision": "2285e8aaa30b2df0508d570172643d1cae40703f",
            "analysis_version": "1.1.0",
            "image": image_info,
            "models": model_results,
            "ensemble": ensemble,
            "processing_status": (
                "failed"
                if completed_model_count == 0
                else "partial"
                if completed_model_count < len(MODEL_CONFIG)
                else "completed"
            ),
            "duration_ms": round((time.monotonic() - inference_started) * 1000),
            "analyzed_at": datetime.now(timezone.utc).isoformat(),
            "error_detail": "; ".join(errors) if errors else None,
        }
    finally:
        if acquired:
            analysis_semaphore.release()
        async with active_hashes_lock:
            active_hashes.discard(image_sha256)
