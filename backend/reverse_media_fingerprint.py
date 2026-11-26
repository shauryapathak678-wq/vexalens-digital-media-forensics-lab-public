"""Local perceptual fingerprints and privacy-preserving media samples."""

from __future__ import annotations

import base64
import hashlib
import math
import tempfile
import time
from pathlib import Path
from typing import Any

import cv2
import numpy as np


MAX_MEDIA_BYTES = 100 * 1024 * 1024
MAX_VIDEO_DURATION_SECONDS = 600
MAX_FRAME_SAMPLE_COUNT = 8
MAX_PROVIDER_IMAGE_BYTES = 7 * 1024 * 1024
SUPPORTED_MEDIA: dict[str, dict[str, Any]] = {
    "image/jpeg": {"extensions": {".jpg", ".jpeg"}, "kind": "image"},
    "image/png": {"extensions": {".png"}, "kind": "image"},
    "image/webp": {"extensions": {".webp"}, "kind": "image"},
    "image/tiff": {"extensions": {".tif", ".tiff"}, "kind": "image"},
    "image/bmp": {"extensions": {".bmp"}, "kind": "image"},
    "video/mp4": {"extensions": {".mp4", ".m4v"}, "kind": "video"},
    "video/quicktime": {"extensions": {".mov"}, "kind": "video"},
    "video/webm": {"extensions": {".webm"}, "kind": "video"},
}


class ReverseMediaInputError(ValueError):
    pass


def _validate_media(bytes_: bytes, mime_type: str, file_name: str) -> str:
    media = SUPPORTED_MEDIA.get(mime_type)
    if not media or Path(file_name).suffix.lower() not in media["extensions"]:
        raise ReverseMediaInputError("Choose a supported image or video with a matching MIME type and extension.")
    if not bytes_ or len(bytes_) > MAX_MEDIA_BYTES:
        raise ReverseMediaInputError("Media must be non-empty and no larger than 100 MiB.")

    signature_matches = {
        "image/jpeg": lambda: bytes_.startswith(b"\xff\xd8\xff"),
        "image/png": lambda: bytes_.startswith(b"\x89PNG\r\n\x1a\n"),
        "image/webp": lambda: len(bytes_) >= 12 and bytes_[:4] == b"RIFF" and bytes_[8:12] == b"WEBP",
        "image/tiff": lambda: bytes_.startswith((b"II*\x00", b"MM\x00*")),
        "image/bmp": lambda: bytes_.startswith(b"BM"),
        "video/mp4": lambda: len(bytes_) >= 12 and bytes_[4:8] == b"ftyp",
        "video/quicktime": lambda: len(bytes_) >= 12 and bytes_[4:8] == b"ftyp",
        "video/webm": lambda: bytes_.startswith(b"\x1a\x45\xdf\xa3"),
    }
    if not signature_matches[mime_type]():
        raise ReverseMediaInputError("The file signature does not match the recorded media type.")
    return str(media["kind"])


def _ensure_bgr(frame: np.ndarray) -> np.ndarray:
    if frame.ndim == 2:
        return cv2.cvtColor(frame, cv2.COLOR_GRAY2BGR)
    if frame.shape[2] == 4:
        return cv2.cvtColor(frame, cv2.COLOR_BGRA2BGR)
    return frame


def _hash_bits(bits: np.ndarray) -> str:
    value = 0
    for bit in bits.flat:
        value = (value << 1) | int(bool(bit))
    return f"{value:016x}"


def _perceptual_hash(gray: np.ndarray) -> str:
    resized = cv2.resize(gray, (32, 32), interpolation=cv2.INTER_AREA).astype(np.float32)
    low_frequency = cv2.dct(resized)[:8, :8]
    median = float(np.median(low_frequency.flatten()[1:]))
    return _hash_bits(low_frequency > median)


def _difference_hash(gray: np.ndarray) -> str:
    resized = cv2.resize(gray, (9, 8), interpolation=cv2.INTER_AREA)
    return _hash_bits(resized[:, 1:] > resized[:, :-1])


def _average_hash(gray: np.ndarray) -> str:
    resized = cv2.resize(gray, (8, 8), interpolation=cv2.INTER_AREA)
    return _hash_bits(resized > float(resized.mean()))


def _crop_perceptual_hashes(gray: np.ndarray) -> list[str]:
    height, width = gray.shape
    middle_y, middle_x = height // 2, width // 2
    crops = (
        gray[:middle_y, :middle_x],
        gray[:middle_y, middle_x:],
        gray[middle_y:, :middle_x],
        gray[middle_y:, middle_x:],
    )
    return [_perceptual_hash(crop) for crop in crops if crop.size]


def _encode_jpeg(frame: np.ndarray, maximum_edge: int, quality: int) -> bytes:
    height, width = frame.shape[:2]
    scale = min(1.0, maximum_edge / max(height, width))
    if scale < 1:
        frame = cv2.resize(
            frame,
            (max(1, round(width * scale)), max(1, round(height * scale))),
            interpolation=cv2.INTER_AREA,
        )
    encode_ok, encoded = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not encode_ok:
        raise ReverseMediaInputError("A sampled media frame could not be encoded.")
    return encoded.tobytes()


def _fingerprint_frame(
    frame: np.ndarray,
    frame_index: int,
    timestamp_seconds: float | None,
    include_provider_image: bool,
) -> dict[str, Any]:
    bgr_frame = _ensure_bgr(frame)
    gray = cv2.cvtColor(bgr_frame, cv2.COLOR_BGR2GRAY)
    height, width = gray.shape
    result: dict[str, Any] = {
        "frame_index": frame_index,
        "timestamp_seconds": timestamp_seconds,
        "width": width,
        "height": height,
        "decoded_frame_sha256": hashlib.sha256(bgr_frame.tobytes()).hexdigest(),
        "phash": _perceptual_hash(gray),
        "dhash": _difference_hash(gray),
        "ahash": _average_hash(gray),
        "crop_phashes": _crop_perceptual_hashes(gray),
        "thumbnail_base64": base64.b64encode(_encode_jpeg(bgr_frame, 320, 70)).decode("ascii"),
    }
    if include_provider_image:
        provider_image = _encode_jpeg(bgr_frame, 1600, 85)
        if len(provider_image) > MAX_PROVIDER_IMAGE_BYTES:
            provider_image = _encode_jpeg(bgr_frame, 1024, 75)
        if len(provider_image) > MAX_PROVIDER_IMAGE_BYTES:
            raise ReverseMediaInputError("A metadata-stripped provider derivative exceeds the 7 MiB request limit.")
        result["provider_image_base64"] = base64.b64encode(provider_image).decode("ascii")
    return result


def fingerprint_reverse_media(
    bytes_: bytes,
    mime_type: str,
    file_name: str,
    frame_sample_count: int = 4,
    include_provider_images: bool = False,
) -> dict[str, Any]:
    """Fingerprint one image or a bounded set of video frames without changing the source bytes."""
    media_type = _validate_media(bytes_, mime_type, file_name)
    if not 1 <= frame_sample_count <= MAX_FRAME_SAMPLE_COUNT:
        raise ReverseMediaInputError("Video frame sample count must be between 1 and 8.")

    started = time.perf_counter()
    source_sha256 = hashlib.sha256(bytes_).hexdigest()
    video_metadata: dict[str, float | int] | None = None
    if media_type == "image":
        image = cv2.imdecode(np.frombuffer(bytes_, dtype=np.uint8), cv2.IMREAD_UNCHANGED)
        if image is None:
            raise ReverseMediaInputError("The image could not be decoded.")
        frames = [_fingerprint_frame(image, 0, None, include_provider_images)]
    else:
        suffix = Path(file_name).suffix.lower()
        with tempfile.TemporaryDirectory(prefix="vexalens_reverse_media_") as folder:
            video_path = Path(folder) / f"evidence{suffix}"
            video_path.write_bytes(bytes_)
            capture = cv2.VideoCapture(str(video_path))
            if not capture.isOpened():
                capture.release()
                raise ReverseMediaInputError("The video could not be opened by the local decoder.")
            try:
                frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
                fps = float(capture.get(cv2.CAP_PROP_FPS))
                width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
                height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
                if frame_count < 1 or not math.isfinite(fps) or fps <= 0:
                    raise ReverseMediaInputError("The video has no valid frame count or frame rate.")
                duration = frame_count / fps
                if duration > MAX_VIDEO_DURATION_SECONDS:
                    raise ReverseMediaInputError(
                        f"Video duration exceeds the {MAX_VIDEO_DURATION_SECONDS}-second analysis limit."
                    )
                video_metadata = {
                    "frame_count": frame_count,
                    "fps": fps,
                    "width": width,
                    "height": height,
                    "duration_seconds": duration,
                }
                indices = np.linspace(
                    0,
                    frame_count - 1,
                    min(frame_sample_count, frame_count),
                    dtype=int,
                )
                frames = []
                for frame_index in dict.fromkeys(int(index) for index in indices):
                    capture.set(cv2.CAP_PROP_POS_FRAMES, frame_index)
                    read_ok, frame = capture.read()
                    if read_ok and frame is not None:
                        frames.append(_fingerprint_frame(
                            frame,
                            frame_index,
                            frame_index / fps,
                            include_provider_images,
                        ))
            finally:
                capture.release()
        if not frames:
            raise ReverseMediaInputError("No readable frames were found in the video.")

    return {
        "status": "completed",
        "media_type": media_type,
        "source_sha256": source_sha256,
        "analyzed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "video_metadata": video_metadata,
        "frames": frames,
        "local_methods": [
            "SHA-256 exact-file identity",
            "64-bit pHash, dHash, and aHash",
            "quadrant crop pHash candidates",
        ],
        "limitations": [
            "Local pHash matches are visual similarity measurements, not proof of duplicate origin.",
            "No local semantic embedding model is installed; semantic similarity is not claimed.",
            "A video frame match is not a full-video match.",
        ],
        "processing_seconds": time.perf_counter() - started,
    }
