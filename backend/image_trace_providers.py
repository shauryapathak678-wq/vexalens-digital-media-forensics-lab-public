import asyncio
import base64
import os
import time
from dataclasses import dataclass
from typing import Any

import httpx


ENGINE_TIMEOUT_SECONDS = 30
ENGINE_RETRY_COUNT = 1
GOOGLE_VISION_URL = "https://vision.googleapis.com/v1/images:annotate"
YANDEX_IMAGE_SEARCH_URL = "https://searchapi.api.cloud.yandex.net/v2/image/search_by_image"
TINEYE_SEARCH_URL = "https://api.tineye.com/rest/search/"

PROVIDER_ENV = {
    "google_vision": ("GOOGLE_CLOUD_VISION_API_KEY",),
    "yandex": ("YANDEX_SEARCH_API_KEY", "YANDEX_SEARCH_FOLDER_ID"),
    "tineye": ("TINEYE_API_KEY",),
}


class ProviderRequestError(Exception):
    def __init__(
        self,
        message: str,
        category: str,
        attempts: int = 0,
        http_status: int | None = None,
    ) -> None:
        super().__init__(message)
        self.category = category
        self.attempts = attempts
        self.http_status = http_status


@dataclass(frozen=True)
class ProviderResponse:
    payload: dict[str, Any]
    elapsed_ms: int
    attempts: int


def missing_provider_settings(engine: str) -> list[str]:
    required = PROVIDER_ENV.get(engine, ())
    return [
        name
        for name in required
        if not os.environ.get(name, "").strip()
    ]


async def _send_request(
    engine: str,
    image_bytes: bytes,
    timeout_seconds: float,
) -> httpx.Response:
    settings = PROVIDER_ENV[engine]
    values = {name: os.environ[name].strip() for name in settings}
    timeout = httpx.Timeout(timeout_seconds)

    async with httpx.AsyncClient(timeout=timeout) as client:
        if engine == "google_vision":
            return await client.post(
                GOOGLE_VISION_URL,
                headers={"x-goog-api-key": values["GOOGLE_CLOUD_VISION_API_KEY"]},
                json={
                    "requests": [{
                        "image": {"content": base64.b64encode(image_bytes).decode("ascii")},
                        "features": [{"type": "WEB_DETECTION", "maxResults": 50}],
                    }],
                },
            )
        if engine == "yandex":
            return await client.post(
                YANDEX_IMAGE_SEARCH_URL,
                headers={"Authorization": f"Api-Key {values['YANDEX_SEARCH_API_KEY']}"},
                json={
                    "folderId": values["YANDEX_SEARCH_FOLDER_ID"],
                    "data": base64.b64encode(image_bytes).decode("ascii"),
                    "page": 0,
                },
            )
        if engine == "tineye":
            return await client.post(
                TINEYE_SEARCH_URL,
                headers={"X-API-KEY": values["TINEYE_API_KEY"]},
                files={"image_upload": ("image.jpg", image_bytes, "image/jpeg")},
                data={"limit": "50"},
            )
    raise ValueError(f"Unsupported Image Trace provider: {engine}")


def _http_error_message(status_code: int) -> str:
    if status_code in (401, 403):
        return f"API key rejected or provider permission denied (HTTP {status_code})."
    if status_code == 429:
        return "Provider quota or rate limit exceeded (HTTP 429)."
    return f"Provider returned HTTP {status_code}."


def _provider_error_message(engine: str, payload: dict[str, Any]) -> str | None:
    if engine == "google_vision":
        responses = payload.get("responses")
        if isinstance(responses, list) and responses and isinstance(responses[0], dict):
            error = responses[0].get("error")
            if isinstance(error, dict) and isinstance(error.get("message"), str):
                return error["message"][:300]
        error = payload.get("error")
        if isinstance(error, dict) and isinstance(error.get("message"), str):
            return error["message"][:300]
    elif engine == "tineye":
        code = payload.get("code")
        if isinstance(code, int) and code != 200:
            messages = payload.get("messages")
            detail = "; ".join(item for item in messages if isinstance(item, str)) if isinstance(messages, list) else ""
            return detail[:300] or f"TinEye returned API status {code}."
    else:
        error = payload.get("error")
        if isinstance(error, dict) and isinstance(error.get("message"), str):
            return error["message"][:300]
    return None


async def request_provider(
    engine: str,
    image_bytes: bytes,
    timeout_seconds: float = ENGINE_TIMEOUT_SECONDS,
) -> ProviderResponse:
    missing = missing_provider_settings(engine)
    if missing:
        raise ProviderRequestError(
            f"Missing server configuration: {', '.join(missing)}.",
            "not_configured",
        )

    started = time.monotonic()
    deadline = asyncio.get_running_loop().time() + timeout_seconds
    attempts = 0

    while attempts <= ENGINE_RETRY_COUNT:
        remaining = deadline - asyncio.get_running_loop().time()
        if remaining <= 0:
            raise ProviderRequestError(
                f"Timed out after {timeout_seconds:g} seconds.",
                "timeout",
                attempts,
            )

        attempts += 1
        attempt_timeout = remaining if attempts > 1 else remaining / 2
        try:
            response = await asyncio.wait_for(
                _send_request(engine, image_bytes, attempt_timeout),
                timeout=attempt_timeout,
            )
        except (httpx.TimeoutException, httpx.RequestError, asyncio.TimeoutError) as exc:
            if attempts <= ENGINE_RETRY_COUNT and deadline - asyncio.get_running_loop().time() > 0:
                continue
            category = "timeout" if isinstance(exc, (httpx.TimeoutException, asyncio.TimeoutError)) else "network_error"
            message = (
                f"Timed out after {timeout_seconds:g} seconds."
                if category == "timeout"
                else f"Network request failed ({type(exc).__name__})."
            )
            raise ProviderRequestError(message, category, attempts) from exc

        if 500 <= response.status_code <= 599 and attempts <= ENGINE_RETRY_COUNT:
            continue
        if not 200 <= response.status_code < 300:
            raise ProviderRequestError(
                _http_error_message(response.status_code),
                "http_error",
                attempts,
                response.status_code,
            )

        try:
            payload = response.json()
        except ValueError as exc:
            raise ProviderRequestError(
                "Provider returned invalid JSON.",
                "parse_error",
                attempts,
                response.status_code,
            ) from exc
        if not isinstance(payload, dict):
            raise ProviderRequestError(
                "Provider returned an unexpected JSON response.",
                "parse_error",
                attempts,
                response.status_code,
            )

        provider_error = _provider_error_message(engine, payload)
        if provider_error:
            raise ProviderRequestError(provider_error, "provider_error", attempts, response.status_code)

        return ProviderResponse(
            payload=payload,
            elapsed_ms=round((time.monotonic() - started) * 1000),
            attempts=attempts,
        )

    raise ProviderRequestError("Provider request failed.", "provider_error", attempts)
