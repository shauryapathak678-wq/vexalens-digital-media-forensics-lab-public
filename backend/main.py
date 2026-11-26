"""
VexaLens Forensic FastAPI Server
Exposes Error Level Analysis (ELA) endpoints powered by Pillow and NumPy.
"""

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Body, Header, Request, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from fastapi.responses import HTMLResponse, StreamingResponse
from starlette.concurrency import run_in_threadpool
from typing import Optional, Literal
import base64
import hashlib
import hmac
import json
import re
import asyncio
import logging
import tempfile
from pathlib import Path
from backend.syncnet_service import (
    SyncNetInferenceError,
    SyncNetInputError,
    SyncNetNotConfiguredError,
    analyze_syncnet_video,
    get_syncnet_status,
)
from backend.cctv_detector import analyze_video as analyze_cctv_video
from backend.genconvit_service import (
    GenConViTInferenceError,
    GenConViTInputError,
    GenConViTNotConfiguredError,
    analyze_genconvit_fast_video,
    analyze_genconvit_video,
    get_genconvit_status,
    warm_genconvit_fast_model,
)
from backend.ela_engine import perform_ela, ChannelMode
from backend.reverse_media_fingerprint import (
    MAX_MEDIA_BYTES as REVERSE_MEDIA_MAX_BYTES,
    ReverseMediaInputError,
    fingerprint_reverse_media,
)
from backend.video_genealogy import (
    MAX_MEDIA_COUNT as VIDEO_GENEALOGY_MAX_MEDIA_COUNT,
    MAX_VIDEO_BYTES as VIDEO_GENEALOGY_MAX_VIDEO_BYTES,
    SUPPORTED_HASH_BITS as VIDEO_GENEALOGY_SUPPORTED_HASH_BITS,
    SUPPORTED_VIDEO_EXTENSIONS as VIDEO_GENEALOGY_VIDEO_EXTENSIONS,
    VideoGenealogyInputError,
    analyze_video_set,
    persist_video_genealogy_analysis,
)
from backend.image_trace import (
    MAX_IMAGE_BYTES as IMAGE_TRACE_MAX_IMAGE_BYTES,
    MAX_KNOWN_LINKS as IMAGE_TRACE_MAX_KNOWN_LINKS,
    SUPPORTED_ENGINES as IMAGE_TRACE_SUPPORTED_ENGINES,
    ImageTraceInputError,
    UnsafeImageUrlError,
    analyze_image_trace,
    decode_image,
    normalize_result_url,
    scan_known_links,
    _is_search_engine_results_page,
    _resolve_public_url,
    _resolve_case_id,
    stream_image_trace,
    get_search_record,
    list_search_records,
    render_case_report,
    verify_search_log,
)

app = FastAPI(
    title="VexaLens Forensic ELA API",
    version="2.0.0",
    description="Error Level Analysis (ELA) and Image Forensic Services powered by Pillow"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

SYNCNET_MAX_VIDEO_BYTES = 128 * 1024 * 1024
SYNCNET_ALLOWED_VIDEO_EXTENSIONS = {".avi", ".m4v", ".mkv", ".mov", ".mp4", ".webm"}
CCTV_MAX_VIDEO_BYTES = 128 * 1024 * 1024
CCTV_ALLOWED_VIDEO_EXTENSIONS = {".avi", ".m4v", ".mkv", ".mov", ".mp4", ".webm"}
VIDEO_GENEALOGY_MAX_TOTAL_UPLOAD_BYTES = 512 * 1024 * 1024
GENCONVIT_MAX_VIDEO_BYTES = 128 * 1024 * 1024
GENCONVIT_ALLOWED_VIDEO_EXTENSIONS = {".avi", ".m4v", ".mkv", ".mov", ".mp4", ".webm"}
logger = logging.getLogger(__name__)
_GENCONVIT_WARMUP_TASK: asyncio.Task | None = None


@app.on_event("startup")
async def warm_genconvit_rapid_screen():
    global _GENCONVIT_WARMUP_TASK

    async def warm_model():
        try:
            await run_in_threadpool(warm_genconvit_fast_model)
        except (GenConViTInferenceError, GenConViTNotConfiguredError) as exc:
            logger.warning("GenConViT rapid mode is unavailable: %s", exc)

    _GENCONVIT_WARMUP_TASK = asyncio.create_task(warm_model())


@app.get("/", response_class=HTMLResponse)
def image_trace_home():
    page_path = Path(__file__).resolve().parent.parent / "public" / "image-trace.html"
    try:
        page = page_path.read_text(encoding="utf-8")
    except OSError as exc:
        logger.exception("Could not load the Image Trace page from %s", page_path)
        raise HTTPException(status_code=503, detail="The Image Trace page is not available.") from exc
    return HTMLResponse(page)


@app.get("/api/syncnet/health")
def syncnet_health():
    return get_syncnet_status()


@app.get("/api/genconvit/health")
def genconvit_health():
    return get_genconvit_status()


@app.post("/api/reverse-media/fingerprint")
async def fingerprint_reverse_media_endpoint(
    request: Request,
    x_evidence_sha256: str = Header(..., min_length=64, max_length=64),
    x_file_name: str = Header(..., min_length=1, max_length=255),
    x_media_mime_type: str = Header(..., min_length=3, max_length=100),
    x_frame_sample_count: int = Header(4, ge=1, le=8),
    x_include_provider_images: bool = Header(False),
):
    if not re.fullmatch(r"[a-fA-F0-9]{64}", x_evidence_sha256):
        raise HTTPException(status_code=400, detail="A valid evidence SHA-256 is required.")
    if Path(x_file_name).name != x_file_name or "/" in x_file_name or "\\" in x_file_name:
        raise HTTPException(status_code=400, detail="A plain evidence filename is required.")
    if request.headers.get("content-type", "").split(";", 1)[0].lower() != "application/octet-stream":
        raise HTTPException(status_code=415, detail="Media must be sent as application/octet-stream.")

    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > REVERSE_MEDIA_MAX_BYTES:
                raise HTTPException(status_code=413, detail="Media exceeds the 100 MiB local fingerprinting limit.")
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid Content-Length header.") from exc

    media_bytes = bytearray()
    digest = hashlib.sha256()
    async for chunk in request.stream():
        media_bytes.extend(chunk)
        digest.update(chunk)
        if len(media_bytes) > REVERSE_MEDIA_MAX_BYTES:
            raise HTTPException(status_code=413, detail="Media exceeds the 100 MiB local fingerprinting limit.")
    actual_sha256 = digest.hexdigest()
    if not media_bytes:
        raise HTTPException(status_code=400, detail="The selected media file is empty.")
    if not hmac.compare_digest(actual_sha256.lower(), x_evidence_sha256.lower()):
        raise HTTPException(status_code=422, detail="Uploaded bytes do not match the evidence SHA-256.")

    try:
        result = await run_in_threadpool(
            fingerprint_reverse_media,
            bytes(media_bytes),
            x_media_mime_type,
            x_file_name,
            x_frame_sample_count,
            x_include_provider_images,
        )
        return result
    except ReverseMediaInputError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/genconvit/analyze")
async def analyze_genconvit_video_endpoint(
    request: Request,
    x_evidence_sha256: str = Header(..., min_length=64, max_length=64),
    x_file_extension: str = Header(".mp4", min_length=4, max_length=5),
    x_analysis_mode: str = Header("rapid", min_length=4, max_length=5),
):
    extension = x_file_extension.lower()
    analysis_mode = x_analysis_mode.lower()
    if extension not in GENCONVIT_ALLOWED_VIDEO_EXTENSIONS:
        raise HTTPException(status_code=415, detail="Choose a supported video file.")
    if analysis_mode != "rapid":
        raise HTTPException(
            status_code=400,
            detail=(
                "Only the time-bounded rapid screen is available. The 15-frame ED+VAE "
                "ensemble exceeded 50 seconds on this CPU and is not offered here."
            ),
        )
    if not re.fullmatch(r"[a-fA-F0-9]{64}", x_evidence_sha256):
        raise HTTPException(status_code=400, detail="A valid evidence SHA-256 is required.")
    if request.headers.get("content-type", "").split(";", 1)[0].lower() != "application/octet-stream":
        raise HTTPException(status_code=415, detail="The video must be sent as application/octet-stream.")

    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > GENCONVIT_MAX_VIDEO_BYTES:
                raise HTTPException(status_code=413, detail="Video exceeds the 128 MB local analysis limit.")
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid Content-Length header.") from exc

    try:
        with tempfile.TemporaryDirectory(prefix="vexalens_genconvit_upload_") as temporary_directory:
            video_path = Path(temporary_directory) / f"evidence{extension}"
            digest = hashlib.sha256()
            received_bytes = 0
            with video_path.open("wb") as output_file:
                async for chunk in request.stream():
                    received_bytes += len(chunk)
                    if received_bytes > GENCONVIT_MAX_VIDEO_BYTES:
                        raise HTTPException(status_code=413, detail="Video exceeds the 128 MB local analysis limit.")
                    digest.update(chunk)
                    output_file.write(chunk)

            if received_bytes == 0:
                raise HTTPException(status_code=400, detail="The selected video file is empty.")
            actual_sha256 = digest.hexdigest()
            if not hmac.compare_digest(actual_sha256.lower(), x_evidence_sha256.lower()):
                raise HTTPException(status_code=422, detail="Uploaded bytes do not match the evidence SHA-256.")

            result = await run_in_threadpool(analyze_genconvit_fast_video, video_path)
            result["source_sha256"] = actual_sha256
            return result
    except GenConViTNotConfiguredError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except GenConViTInputError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except GenConViTInferenceError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/syncnet/analyze")
async def analyze_syncnet_offset(
    request: Request,
    x_evidence_sha256: str = Header(..., min_length=64, max_length=64),
    x_file_extension: str = Header(".mp4", min_length=4, max_length=5),
):
    extension = x_file_extension.lower()
    if extension not in SYNCNET_ALLOWED_VIDEO_EXTENSIONS:
        raise HTTPException(status_code=415, detail="Choose a supported video file.")
    if not re.fullmatch(r"[a-fA-F0-9]{64}", x_evidence_sha256):
        raise HTTPException(status_code=400, detail="A valid evidence SHA-256 is required.")
    if request.headers.get("content-type", "").split(";", 1)[0].lower() != "application/octet-stream":
        raise HTTPException(status_code=415, detail="The video must be sent as application/octet-stream.")

    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > SYNCNET_MAX_VIDEO_BYTES:
                raise HTTPException(status_code=413, detail="Video exceeds the 128 MB local analysis limit.")
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid Content-Length header.") from exc

    try:
        with tempfile.TemporaryDirectory(prefix="vexalens_syncnet_upload_") as temporary_directory:
            video_path = Path(temporary_directory) / f"evidence{extension}"
            digest = hashlib.sha256()
            received_bytes = 0
            with video_path.open("wb") as output_file:
                async for chunk in request.stream():
                    received_bytes += len(chunk)
                    if received_bytes > SYNCNET_MAX_VIDEO_BYTES:
                        raise HTTPException(status_code=413, detail="Video exceeds the 128 MB local analysis limit.")
                    digest.update(chunk)
                    output_file.write(chunk)

            if received_bytes == 0:
                raise HTTPException(status_code=400, detail="The selected video file is empty.")
            if not hmac.compare_digest(digest.hexdigest().lower(), x_evidence_sha256.lower()):
                raise HTTPException(status_code=422, detail="Uploaded bytes do not match the evidence SHA-256.")

            result = await run_in_threadpool(analyze_syncnet_video, video_path)
            result["source_sha256"] = digest.hexdigest()
            return result
    except SyncNetNotConfiguredError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except SyncNetInputError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except SyncNetInferenceError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/cctv/analyze")
async def analyze_cctv_video_endpoint(
    request: Request,
    x_evidence_sha256: str = Header(..., min_length=64, max_length=64),
    x_file_extension: str = Header(".mp4", min_length=4, max_length=5),
):
    extension = x_file_extension.lower()
    if extension not in CCTV_ALLOWED_VIDEO_EXTENSIONS:
        raise HTTPException(status_code=415, detail="Choose a supported video file.")
    if not re.fullmatch(r"[a-fA-F0-9]{64}", x_evidence_sha256):
        raise HTTPException(status_code=400, detail="A valid evidence SHA-256 is required.")
    if request.headers.get("content-type", "").split(";", 1)[0].lower() != "application/octet-stream":
        raise HTTPException(status_code=415, detail="The video must be sent as application/octet-stream.")

    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > CCTV_MAX_VIDEO_BYTES:
                raise HTTPException(status_code=413, detail="Video exceeds the 128 MB local analysis limit.")
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid Content-Length header.") from exc

    with tempfile.TemporaryDirectory(prefix="vexalens_cctv_upload_") as temporary_directory:
        video_path = Path(temporary_directory) / f"evidence{extension}"
        original_digest = hashlib.sha256()
        received_bytes = 0
        with video_path.open("wb") as output_file:
            async for chunk in request.stream():
                received_bytes += len(chunk)
                if received_bytes > CCTV_MAX_VIDEO_BYTES:
                    raise HTTPException(status_code=413, detail="Video exceeds the 128 MB local analysis limit.")
                original_digest.update(chunk)
                output_file.write(chunk)

        if received_bytes == 0:
            raise HTTPException(status_code=400, detail="The selected video file is empty.")
        original_sha256 = original_digest.hexdigest()
        if not hmac.compare_digest(original_sha256.lower(), x_evidence_sha256.lower()):
            raise HTTPException(status_code=422, detail="Uploaded bytes do not match the evidence SHA-256.")

        try:
            result = await run_in_threadpool(analyze_cctv_video, video_path)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        analysis_digest = hashlib.sha256()
        with video_path.open("rb") as analyzed_file:
            for chunk in iter(lambda: analyzed_file.read(1 << 20), b""):
                analysis_digest.update(chunk)
        analysis_sha256 = analysis_digest.hexdigest()
        detector_sha256 = result.get("file", {}).get("sha256")
        if (
            not hmac.compare_digest(original_sha256, analysis_sha256)
            or not isinstance(detector_sha256, str)
            or not hmac.compare_digest(original_sha256, detector_sha256)
        ):
            raise HTTPException(status_code=500, detail="The analysis copy changed during processing; no result was returned.")

        result["custody"] = {
            "source_sha256": original_sha256,
            "analysis_sha256": analysis_sha256,
            "original_unchanged": True,
        }
        return result


@app.post("/api/video-genealogy/analyze")
async def analyze_video_genealogy_endpoint(
    request: Request,
    root: UploadFile = File(...),
    candidates: list[UploadFile] = File(default=[]),
    root_sha256: str = Form(..., min_length=64, max_length=64),
    candidate_sha256: list[str] = Form(default=[]),
    hash_bits: int = Form(256),
    online_search: bool = Form(False),
    search_query: str = Form(""),
    custom_source_link: list[str] = Form(default=[]),
):
    uploads = [root, *candidates]
    expected_hashes = [root_sha256, *candidate_sha256]
    if not 1 <= len(uploads) <= VIDEO_GENEALOGY_MAX_MEDIA_COUNT:
        raise HTTPException(status_code=400, detail="Choose one reference video and up to four candidates.")
    if len(expected_hashes) != len(uploads) or any(
        not re.fullmatch(r"[a-fA-F0-9]{64}", digest) for digest in expected_hashes
    ):
        raise HTTPException(status_code=400, detail="A matching SHA-256 is required for every uploaded video.")
    if hash_bits not in VIDEO_GENEALOGY_SUPPORTED_HASH_BITS:
        raise HTTPException(status_code=400, detail="Choose a 64, 256, or 1024-bit fingerprint.")
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > VIDEO_GENEALOGY_MAX_TOTAL_UPLOAD_BYTES:
                raise HTTPException(status_code=413, detail="The combined upload exceeds the 512 MiB limit.")
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid Content-Length header.") from exc

    with tempfile.TemporaryDirectory(prefix="vexalens_video_genealogy_") as temporary_directory:
        temporary_paths: list[Path] = []
        labels: list[str] = []
        received_hashes: list[str] = []
        received_total = 0
        for index, (upload, expected_hash) in enumerate(zip(uploads, expected_hashes)):
            original_name = (upload.filename or "").replace("\\", "/")
            label = original_name.rsplit("/", 1)[-1][:200] or f"Video {index + 1}"
            extension = Path(label).suffix.lower()
            if extension not in VIDEO_GENEALOGY_VIDEO_EXTENSIONS:
                raise HTTPException(status_code=415, detail=f"{label} must be an AVI, M4V, MKV, MOV, MP4, or WebM video.")
            temporary_path = Path(temporary_directory) / f"media_{index}{extension}"
            digest = hashlib.sha256()
            received_file_bytes = 0
            with temporary_path.open("wb") as output_file:
                while True:
                    chunk = await upload.read(1024 * 1024)
                    if not chunk:
                        break
                    received_file_bytes += len(chunk)
                    received_total += len(chunk)
                    if received_file_bytes > VIDEO_GENEALOGY_MAX_VIDEO_BYTES:
                        raise HTTPException(status_code=413, detail=f"{label} exceeds the 128 MiB per-video limit.")
                    if received_total > VIDEO_GENEALOGY_MAX_TOTAL_UPLOAD_BYTES:
                        raise HTTPException(status_code=413, detail="The combined upload exceeds the 512 MiB limit.")
                    digest.update(chunk)
                    output_file.write(chunk)
            actual_hash = digest.hexdigest()
            if received_file_bytes == 0:
                raise HTTPException(status_code=400, detail=f"{label} is empty.")
            if not hmac.compare_digest(actual_hash.lower(), expected_hash.lower()):
                raise HTTPException(status_code=422, detail=f"{label} does not match its browser-computed SHA-256.")
            temporary_paths.append(temporary_path)
            labels.append(label)
            received_hashes.append(actual_hash)

        try:
            result = await run_in_threadpool(
                analyze_video_set,
                temporary_paths,
                labels,
                hash_bits,
                online_search,
                search_query,
                custom_source_link,
                False,
            )
        except VideoGenealogyInputError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        for index, temporary_path in enumerate(temporary_paths):
            analysis_hash = hashlib.sha256()
            with temporary_path.open("rb") as analyzed_file:
                for chunk in iter(lambda: analyzed_file.read(1 << 20), b""):
                    analysis_hash.update(chunk)
            analysis_copy_hash = analysis_hash.hexdigest()
            if (
                not hmac.compare_digest(received_hashes[index], analysis_copy_hash)
                or not hmac.compare_digest(result["files"][index]["sha256"], analysis_copy_hash)
            ):
                raise HTTPException(
                    status_code=500,
                    detail="A temporary analysis copy changed; no genealogy result was saved.",
                )
            result["files"][index]["custody"] = {
                "source_sha256": received_hashes[index],
                "analysis_copy_sha256": analysis_copy_hash,
                "original_unchanged": True,
            }

        persist_video_genealogy_analysis(result)
        return result


@app.post("/api/trace")
async def image_trace_endpoint(
    image: UploadFile = File(...),
    engines: str = Form(""),
    case_id: str = Form(""),
    social_only: bool = Form(False),
    force_refresh: bool = Form(False),
    deep_search: bool = Form(False),
):
    content_length = image.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > IMAGE_TRACE_MAX_IMAGE_BYTES:
                raise HTTPException(status_code=413, detail="Image exceeds the 15 MiB upload limit.")
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid image Content-Length header.") from exc

    image_bytes = await image.read(IMAGE_TRACE_MAX_IMAGE_BYTES + 1)
    if len(image_bytes) > IMAGE_TRACE_MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Image exceeds the 15 MiB upload limit.")
    selected_engines = list(dict.fromkeys(engine.strip().lower() for engine in engines.split(",") if engine.strip()))
    if not selected_engines:
        selected_engines = list(IMAGE_TRACE_SUPPORTED_ENGINES)
    unsupported = [engine for engine in selected_engines if engine not in IMAGE_TRACE_SUPPORTED_ENGINES]
    if unsupported:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported search engine(s): {', '.join(unsupported)}.",
        )

    try:
        return await analyze_image_trace(
            image_bytes,
            case_id,
            selected_engines,
            social_only,
            force_refresh,
            deep_search,
        )
    except ImageTraceInputError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/trace/stream")
async def image_trace_stream_endpoint(
    image: UploadFile = File(...),
    engines: str = Form(""),
    case_id: str = Form(""),
    social_only: bool = Form(False),
    force_refresh: bool = Form(False),
    deep_search: bool = Form(False),
):
    content_length = image.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > IMAGE_TRACE_MAX_IMAGE_BYTES:
                raise HTTPException(status_code=413, detail="Image exceeds the 15 MiB upload limit.")
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid image Content-Length header.") from exc

    image_bytes = await image.read(IMAGE_TRACE_MAX_IMAGE_BYTES + 1)
    if len(image_bytes) > IMAGE_TRACE_MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Image exceeds the 15 MiB upload limit.")
    selected_engines = list(dict.fromkeys(engine.strip().lower() for engine in engines.split(",") if engine.strip()))
    if not selected_engines:
        selected_engines = list(IMAGE_TRACE_SUPPORTED_ENGINES)
    unsupported = [engine for engine in selected_engines if engine not in IMAGE_TRACE_SUPPORTED_ENGINES]
    if unsupported:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported search engine(s): {', '.join(unsupported)}.",
        )

    try:
        decode_image(image_bytes)
        _resolve_case_id(case_id)
    except ImageTraceInputError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    async def events():
        try:
            async for event in stream_image_trace(
                image_bytes,
                case_id,
                selected_engines,
                social_only,
                force_refresh,
                deep_search,
            ):
                yield f"data:{json.dumps(event, separators=(',', ':'), ensure_ascii=False)}\n\n"
        except Exception:
            logger.exception("Image Trace streaming request failed")
            yield f"data:{json.dumps({'type': 'error', 'error': 'Image Trace failed while processing this request.'})}\n\n"

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/scan")
async def image_trace_known_links_endpoint(
    image: UploadFile = File(...),
    urls: str = Form(""),
    authorization_note: str = Form(...),
    case_id: str = Form(""),
):
    content_length = image.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > IMAGE_TRACE_MAX_IMAGE_BYTES:
                raise HTTPException(status_code=413, detail="Image exceeds the 15 MiB upload limit.")
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid image Content-Length header.") from exc

    image_bytes = await image.read(IMAGE_TRACE_MAX_IMAGE_BYTES + 1)
    if len(image_bytes) > IMAGE_TRACE_MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Image exceeds the 15 MiB upload limit.")
    submitted_urls = [line.strip() for line in urls.splitlines() if line.strip()]
    if not submitted_urls or len(submitted_urls) > IMAGE_TRACE_MAX_KNOWN_LINKS:
        raise HTTPException(
            status_code=400,
            detail=f"Provide between 1 and {IMAGE_TRACE_MAX_KNOWN_LINKS} public URLs, one per line.",
        )
    if not authorization_note.strip() or len(authorization_note) > 500:
        raise HTTPException(status_code=400, detail="Provide an authorization note of 1 to 500 characters.")
    normalized_urls: list[str] = []
    seen_urls: set[str] = set()
    for submitted_url in submitted_urls:
        normalized_url = normalize_result_url(submitted_url)
        if not normalized_url or _is_search_engine_results_page(normalized_url):
            raise HTTPException(status_code=400, detail="Each URL must be a public HTTP(S) post or profile page.")
        if normalized_url not in seen_urls:
            normalized_urls.append(normalized_url)
            seen_urls.add(normalized_url)
    if len(normalized_urls) > IMAGE_TRACE_MAX_KNOWN_LINKS:
        raise HTTPException(
            status_code=400,
            detail=f"Provide no more than {IMAGE_TRACE_MAX_KNOWN_LINKS} unique public URLs.",
        )

    try:
        for normalized_url in normalized_urls:
            await asyncio.wait_for(asyncio.to_thread(_resolve_public_url, normalized_url), timeout=10)
        return await scan_known_links(image_bytes, normalized_urls, authorization_note, case_id)
    except asyncio.TimeoutError as exc:
        raise HTTPException(status_code=400, detail="A supplied URL did not resolve within 10 seconds.") from exc
    except (OSError, UnsafeImageUrlError) as exc:
        raise HTTPException(status_code=400, detail="A supplied URL did not resolve to a public address.") from exc
    except ImageTraceInputError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/cases")
def image_trace_cases(limit: int = Query(50, ge=1, le=200)):
    return {"cases": list_search_records(limit)}


@app.get("/api/cases/{record_id}/report", response_class=HTMLResponse)
def image_trace_case_report(record_id: int):
    record = get_search_record(record_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Image Trace case record not found.")
    return HTMLResponse(render_case_report(record))


@app.get("/api/cases/{record_id}")
def image_trace_case(record_id: int):
    record = get_search_record(record_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Image Trace case record not found.")
    return record


@app.get("/api/verify-log")
def image_trace_verify_log():
    return verify_search_log()


class ELARequest(BaseModel):
    image_base64: str = Field(..., description="Base64 encoded image string or data URL")
    quality: int = Field(95, ge=1, le=95, description="JPEG recompression quality (1-95; below 90 is discouraged)")
    multiplier: float = Field(1.0, ge=0.5, le=5.0, description="Heatmap amplification after automatic normalization")
    z_threshold: float = Field(6.0, ge=1.0, le=20.0, description="Robust block anomaly z-score threshold")
    channel: ChannelMode = Field("rgb", description="Color channel filtering (rgb, r, g, b, luminance)")
    invert: bool = Field(False, description="Whether to invert the heatmap colormap")
    luminance_only: bool = Field(False, description="Render difference in luminance/grayscale")
    file_name: Optional[str] = Field("image.jpg", description="Original file name")

@app.get("/api/ela/health")
def ela_health():
    return {
        "status": "operational",
        "service": "VexaLens ELA Forensic Engine",
        "features": ["reverse_media_fingerprint", "video_genealogy", "image_trace"],
        "engine": "Pillow / NumPy",
        "supported_formats": ["JPEG", "PNG", "WEBP", "TIFF", "BMP"]
    }

@app.post("/api/ela/analyze")
def analyze_ela_json(request: ELARequest):
    """Analyze an image sent as base64 string or data URL."""
    b64_str = request.image_base64
    if "," in b64_str:
        b64_str = b64_str.split(",", 1)[1]

    try:
        image_bytes = base64.b64decode(b64_str)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to decode base64 image: {str(e)}")

    try:
        result = perform_ela(
            image_bytes=image_bytes,
            quality=request.quality,
            multiplier=request.multiplier,
            channel=request.channel,
            invert=request.invert,
            luminance_only=request.luminance_only,
            file_name=request.file_name or "image.jpg",
            z_threshold=request.z_threshold,
        )
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"ELA processing error: {str(e)}")

@app.post("/api/ela/upload")
async def analyze_ela_upload(
    file: UploadFile = File(...),
    quality: int = Form(95, ge=1, le=95),
    multiplier: float = Form(1.0, ge=0.5, le=5.0),
    z_threshold: float = Form(6.0, ge=1.0, le=20.0),
    channel: str = Form("rgb"),
    invert: bool = Form(False),
    luminance_only: bool = Form(False)
):
    """Analyze an uploaded multipart/form-data image file."""
    try:
        image_bytes = await file.read()
        if not image_bytes:
            raise HTTPException(status_code=400, detail="Uploaded file is empty.")

        chan = channel.lower()
        if chan not in ("rgb", "r", "g", "b", "luminance"):
            chan = "rgb"

        result = perform_ela(
            image_bytes=image_bytes,
            quality=quality,
            multiplier=multiplier,
            channel=chan,  # type: ignore
            invert=invert,
            luminance_only=luminance_only,
            file_name=file.filename or "upload.jpg",
            z_threshold=z_threshold,
        )
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Internal ELA processing error: {str(e)}")

from typing import Optional, Literal, List
from backend.face_engine import (
    decode_image_bytes,
    detect_genuine_face,
    compare_two_faces,
    is_redundant_frame,
)
from backend.age_gender_engine import (
    ModelInferenceError,
    ModelUnavailableError,
    estimate_apparent_ages,
)
from backend.contrastive_deepfake_detector import (
    MAX_IMAGE_BYTES as CONTRASTIVE_DEEPFAKE_MAX_IMAGE_BYTES,
    ModelUnavailableError as ContrastiveDeepfakeModelUnavailableError,
    analyze_image as analyze_contrastive_deepfake,
)

class FaceDetectRequest(BaseModel):
    image_base64: str = Field(..., description="Base64 encoded image string or data URL")

class AgeEstimateRequest(BaseModel):
    image_base64: str = Field(..., description="Base64 encoded image string or data URL")

@app.post("/api/deepfake/contrastive")
async def analyze_contrastive_deepfake_image(file: UploadFile = File(...)):
    if file.content_type and not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Upload a supported image file.")
    image_bytes = await file.read(CONTRASTIVE_DEEPFAKE_MAX_IMAGE_BYTES + 1)
    if len(image_bytes) > CONTRASTIVE_DEEPFAKE_MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="The image exceeds the 25 MB local analysis limit.")
    try:
        return await run_in_threadpool(analyze_contrastive_deepfake, image_bytes)
    except ContrastiveDeepfakeModelUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

@app.post("/api/age-estimation/analyze")
def analyze_local_apparent_age(request: AgeEstimateRequest):
    try:
        image = decode_image_bytes(request.image_base64)
        if image.shape[0] * image.shape[1] > 30_000_000:
            raise HTTPException(status_code=413, detail="Image exceeds the 30-megapixel analysis limit.")
        return estimate_apparent_ages(image)
    except ModelUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ModelInferenceError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

class VideoFrameItem(BaseModel):
    timestamp: str
    frame_number: int
    image_base64: str

class FaceCompareRequest(BaseModel):
    reference_image_base64: str
    candidate_frames: List[VideoFrameItem]
    similarity_threshold: float = Field(0.68, ge=0.1, le=1.0)
    cadence_sec: float = Field(0.5, ge=0.1, le=10.0)

@app.post("/api/face-match/detect")
def detect_face_endpoint(req: FaceDetectRequest):
    """Detects human face, extracts 128D embedding, and checks for cartoon/animation."""
    try:
        img_bgr = decode_image_bytes(req.image_base64)
        face_info = detect_genuine_face(img_bgr)
        if not face_info:
            return {
                "detected": False,
                "error": "No human facial region could be located in this image."
            }
        return {
            "detected": True,
            "face": face_info
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Face detection error: {str(e)}")

@app.post("/api/face-match/compare")
def compare_photo_video_endpoint(req: FaceCompareRequest):
    """
    Performs forensic photo-to-video comparison:
    1. Detects reference face (rejects cartoons).
    2. Filters redundant video frames.
    3. Extracts 128D embeddings and calculates distinct facial and scene similarity.
    4. Evaluates against user threshold and cadence.
    """
    try:
        ref_bgr = decode_image_bytes(req.reference_image_base64)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid reference image: {str(e)}")

    ref_face = detect_genuine_face(ref_bgr)
    if not ref_face:
        return {
            "conclusion": "inconclusive",
            "best_facial_similarity": 0.0,
            "best_scene_similarity": 0.0,
            "candidate_matches": [],
            "frames_sampled": len(req.candidate_frames),
            "redundant_frames_skipped": 0,
            "explanation": "No valid human facial region was identified in the reference photograph.",
            "hindi_explanation": "संदर्भ फ़ोटो में कोई वैध मानव चेहरा नहीं मिला।",
            "ref_is_cartoon": False,
        }

    if ref_face.get("is_cartoon"):
        return {
            "conclusion": "cartoon_or_non_human",
            "best_facial_similarity": 0.0,
            "best_scene_similarity": 0.0,
            "candidate_matches": [],
            "frames_sampled": len(req.candidate_frames),
            "redundant_frames_skipped": 0,
            "explanation": "Reference image is an illustration or cartoon animation. Cartoon characters cannot be compared against real human video evidence.",
            "hindi_explanation": "संदर्भ छवि एक कार्टून या एनीमेशन है। कार्टून पात्रों को वास्तविक मानव वीडियो साक्ष्य से नहीं मिलाया जा सकता।",
            "ref_is_cartoon": True,
        }

    candidate_matches = []
    redundant_skipped = 0
    prev_frame_bgr = None

    threshold = req.similarity_threshold
    best_facial_score = 0.0
    best_scene_score = 0.0
    cartoon_detected_in_video = False

    for item in req.candidate_frames:
        try:
            cand_bgr = decode_image_bytes(item.image_base64)
        except Exception:
            continue

        # Redundant frame sampling check
        if prev_frame_bgr is not None and is_redundant_frame(prev_frame_bgr, cand_bgr):
            redundant_skipped += 1
            continue

        prev_frame_bgr = cand_bgr

        cand_face = detect_genuine_face(cand_bgr)
        if not cand_face:
            continue

        if cand_face.get("is_cartoon"):
            cartoon_detected_in_video = True
            facial_sim = 0.0
            scene_sim = 0.0
            conclusion_type = "cartoon_non_human"
        else:
            facial_sim, scene_sim, conclusion_type = compare_two_faces(
                ref_face, cand_face, ref_bgr, cand_bgr
            )

        if facial_sim > best_facial_score:
            best_facial_score = facial_sim
        if scene_sim > best_scene_score:
            best_scene_score = scene_sim

        # Candidate threshold check: filter candidate matches
        if facial_sim >= (threshold - 0.12):
            candidate_matches.append({
                "timestamp": item.timestamp,
                "frame_number": item.frame_number,
                "facial_similarity": facial_sim,
                "scene_similarity": scene_sim,
                "similarityScore": facial_sim,  # backwards compatibility with UI
                "candidateCropUrl": cand_face["crop_data_url"],
                "is_cartoon": cand_face.get("is_cartoon", False),
                "conclusion_type": conclusion_type,
            })

    # Sort candidates by facial similarity descending
    candidate_matches.sort(key=lambda c: c["facial_similarity"], reverse=True)

    # Determine forensic conclusion
    if cartoon_detected_in_video and best_facial_score == 0.0:
        conclusion = "cartoon_or_non_human"
        explanation = "Video footage contains cartoon/animated graphics. Never treat cartoon characters as verified human identity matches."
        hindi_explanation = "वीडियो में कार्टून/एनीमेशन दृश्य पाए गए। कार्टून पात्रों को मानव पहचान के रूप में कभी मान्य नहीं किया जाता।"
    elif len(candidate_matches) == 0 and best_facial_score == 0.0:
        conclusion = "no_match_above_threshold"
        explanation = f"No human faces matching reference exemplar were found across {len(req.candidate_frames)} sampled keyframes."
        hindi_explanation = f"विश्लेषण किए गए {len(req.candidate_frames)} फ़्रेमों में संदर्भ फ़ोटो से मेल खाने वाला कोई चेहरा नहीं मिला।"
    elif best_facial_score >= threshold:
        conclusion = "potential_visual_match"
        explanation = (
            f"Candidate facial structures visually matching reference photograph observed with facial similarity index of "
            f"{(best_facial_score * 100):.1f}% (Threshold: {(threshold * 100):.0f}%, Scene Similarity: {(best_scene_score * 100):.1f}%). "
            "Visual similarity is an investigative lead, not definitive legal proof of individual identity."
        )
        hindi_explanation = f"संदर्भ फ़ोटो से मिलती-जुलती चेहरे की संरचना {(best_facial_score * 100):.1f}% समानता के साथ वीडियो में देखी गई। यह केवल प्रारंभिक जाँच संकेत है।"
    else:
        conclusion = "no_match_above_threshold"
        explanation = (
            f"Sampled video frames yielded facial regions, but none exceeded the required forensic similarity threshold of "
            f"{(threshold * 100):.0f}% (highest candidate: {(best_facial_score * 100):.1f}%)."
        )
        hindi_explanation = f"वीडियो फ़्रेम में चेहरे मिले, परंतु कोई भी निर्धारित समानता सीमा ({(threshold * 100):.0f}%) से अधिक नहीं था।"

    return {
        "conclusion": conclusion,
        "best_facial_similarity": round(best_facial_score, 3),
        "best_scene_similarity": round(best_scene_score, 3),
        "bestSimilarityScore": round(best_facial_score, 3),  # UI compatibility
        "reference_crop_url": ref_face["crop_data_url"],
        "referenceFaceCropUrl": ref_face["crop_data_url"],  # UI compatibility
        "frames_sampled": len(req.candidate_frames),
        "framesSampled": len(req.candidate_frames),  # UI compatibility
        "redundant_frames_skipped": redundant_skipped,
        "candidateMatches": candidate_matches,
        "thresholdApplied": threshold,
        "explanation": explanation,
        "hindiExplanation": hindi_explanation,
        "consentNoticeAcknowledged": True,
        "biometricRetentionDisclaimer": (
            "Biometric feature vectors are generated in ephemeral memory for this analysis session only. "
            "No facial templates are stored or transmitted to external surveillance databases."
        ),
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("backend.main:app", host="127.0.0.1", port=8000, reload=True)

