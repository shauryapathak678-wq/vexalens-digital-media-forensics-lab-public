"""Local face detection and apparent-age group estimation.

The age model predicts one of eight broad age groups. Its output is not a
calibrated probability and must not be interpreted as a person's actual age.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import tempfile
import threading
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any

import cv2
import numpy as np

MODEL_DIR = Path(__file__).resolve().parent / "models"
FACE_CONFIG = MODEL_DIR / "deploy.prototxt"
FACE_WEIGHTS = MODEL_DIR / "res10_300x300_ssd_iter_140000.caffemodel"
AGE_CONFIG = MODEL_DIR / "age_deploy.prototxt"
AGE_WEIGHTS = MODEL_DIR / "age_net.caffemodel"

FACE_CONFIDENCE_THRESHOLD = 0.60
MIN_FACE_SIZE = 64
AGE_GROUPS = (
    "0-2 years",
    "4-6 years",
    "8-12 years",
    "15-20 years",
    "25-32 years",
    "38-43 years",
    "48-53 years",
    "60-100 years",
)

AGE_MODEL_NAME = "Levi-Hassner/Adience 8-class apparent-age classifier"
FACE_MODEL_NAME = "OpenCV ResNet-10 SSD face detector"
AGE_MODEL_LICENSE_NOTE = (
    "The source of the checked-in model files and their redistribution license "
    "are not recorded in this repository."
)
LIMITATIONS = [
    "This model predicts one of eight broad apparent-age groups; it does not estimate exact or actual age.",
    "The model output is not calibrated. No age-confidence percentage is reported.",
    "Age-group estimates can be inaccurate and may vary with age, pose, lighting, image quality, and population representation.",
    "Face angle and occlusion are not measured by the included models.",
    "A face detector score is not a probability that the detection is a real person or a correct identity.",
    AGE_MODEL_LICENSE_NOTE,
]

_face_net_lock = threading.Lock()
_age_net_lock = threading.Lock()


class ModelUnavailableError(RuntimeError):
    """Raised when a required local model cannot be loaded."""


class ModelInferenceError(RuntimeError):
    """Raised when a loaded local model returns unusable output."""


def _validate_model_files() -> None:
    missing = [str(path) for path in (FACE_CONFIG, FACE_WEIGHTS, AGE_CONFIG, AGE_WEIGHTS) if not path.is_file()]
    if missing:
        raise ModelUnavailableError(
            "Local age-estimation model files are missing: " + ", ".join(missing)
        )


def _load_models() -> tuple[Any, Any]:
    _validate_model_files()
    if not hasattr(cv2.dnn, "readNetFromCaffe"):
        raise ModelUnavailableError(
            f"OpenCV {cv2.__version__} does not include the Caffe importer. "
            "Install the backend requirements, which pin OpenCV to the supported 4.x series."
        )

    try:
        model_paths = (FACE_CONFIG, FACE_WEIGHTS, AGE_CONFIG, AGE_WEIGHTS)
        if os.name == "nt" and any(not str(path).isascii() for path in model_paths):
            temp_root = Path(tempfile.gettempdir())
            if not str(temp_root).isascii():
                raise ModelUnavailableError(
                    "OpenCV's Windows Caffe importer requires ASCII model paths. "
                    "Set TEMP to an ASCII-only directory or move the project to an ASCII-only path."
                )
            with tempfile.TemporaryDirectory(prefix="vexalens-age-model-", dir=temp_root) as temp_dir:
                safe_paths = []
                for source in model_paths:
                    destination = Path(temp_dir) / source.name
                    shutil.copyfile(source, destination)
                    safe_paths.append(destination)
                face_net = cv2.dnn.readNetFromCaffe(str(safe_paths[0]), str(safe_paths[1]))
                age_net = cv2.dnn.readNetFromCaffe(str(safe_paths[2]), str(safe_paths[3]))
        else:
            face_net = cv2.dnn.readNetFromCaffe(str(FACE_CONFIG), str(FACE_WEIGHTS))
            age_net = cv2.dnn.readNetFromCaffe(str(AGE_CONFIG), str(AGE_WEIGHTS))
    except ModelUnavailableError:
        raise
    except cv2.error as exc:
        raise ModelUnavailableError(f"Could not load the local Caffe models: {exc}") from exc
    except OSError as exc:
        raise ModelUnavailableError(f"Could not read the local Caffe model files: {exc}") from exc
    return face_net, age_net


@lru_cache(maxsize=1)
def _get_models() -> tuple[Any, Any]:
    return _load_models()


@lru_cache(maxsize=1)
def _model_version() -> str:
    _validate_model_files()
    digest = hashlib.sha256()
    for path in (FACE_CONFIG, FACE_WEIGHTS, AGE_CONFIG, AGE_WEIGHTS):
        digest.update(path.name.encode("utf-8"))
        with path.open("rb") as model_file:
            for chunk in iter(lambda: model_file.read(1024 * 1024), b""):
                digest.update(chunk)
    return f"local-caffe-sha256:{digest.hexdigest()}"


def assess_face_quality(face_bgr: np.ndarray) -> dict[str, Any]:
    """Assess observable crop size, sharpness, exposure, and contrast."""
    height, width = face_bgr.shape[:2]
    observations: list[str] = []
    if width < MIN_FACE_SIZE or height < MIN_FACE_SIZE:
        observations.append(
            f"Face crop is {width}x{height}px; at least {MIN_FACE_SIZE}x{MIN_FACE_SIZE}px is required."
        )

    gray = cv2.cvtColor(face_bgr, cv2.COLOR_BGR2GRAY)
    blur_variance = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    mean_brightness = float(gray.mean())
    contrast_std = float(gray.std())
    clipped_fraction = float(np.mean((gray <= 8) | (gray >= 247)))

    if blur_variance < 25:
        observations.append("The face crop is heavily blurred.")
    elif blur_variance < 60:
        observations.append("The face crop is somewhat soft.")
    if mean_brightness < 35:
        observations.append("The face crop is too dark for reliable estimation.")
    elif mean_brightness > 220:
        observations.append("The face crop is overexposed.")
    if contrast_std < 15:
        observations.append("The face crop has very low contrast.")
    if clipped_fraction > 0.35:
        observations.append("A large portion of the crop is clipped to very dark or bright values.")

    poor = (
        width < MIN_FACE_SIZE
        or height < MIN_FACE_SIZE
        or blur_variance < 25
        or mean_brightness < 35
        or mean_brightness > 220
        or contrast_std < 15
        or clipped_fraction > 0.35
    )
    moderate = (
        blur_variance < 60
        or mean_brightness < 55
        or mean_brightness > 205
        or contrast_std < 25
        or clipped_fraction > 0.20
    )

    if poor:
        state = "poor"
        can_estimate = False
    elif moderate:
        state = "moderate"
        can_estimate = True
    else:
        state = "good"
        can_estimate = True
        observations.append("Measured crop size, sharpness, exposure, and contrast are suitable.")

    observations.append("Face angle and occlusion are not assessed.")
    return {
        "state": state,
        "can_estimate": can_estimate,
        "metrics": {
            "width_px": width,
            "height_px": height,
            "laplacian_variance": round(blur_variance, 2),
            "mean_brightness": round(mean_brightness, 2),
            "contrast_std": round(contrast_std, 2),
            "clipped_fraction": round(clipped_fraction, 4),
        },
        "observations": observations,
    }


def _detect_faces(image_bgr: np.ndarray, face_net: Any) -> list[dict[str, Any]]:
    height, width = image_bgr.shape[:2]
    blob = cv2.dnn.blobFromImage(
        image_bgr,
        1.0,
        (300, 300),
        (104.0, 177.0, 123.0),
        swapRB=False,
        crop=False,
    )
    try:
        with _face_net_lock:
            face_net.setInput(blob)
            detections = np.asarray(face_net.forward())
    except cv2.error as exc:
        raise ModelInferenceError(f"Local face detector inference failed: {exc}") from exc
    if detections.ndim != 4 or detections.shape[0] < 1 or detections.shape[1] < 1 or detections.shape[3] < 7:
        raise ModelInferenceError("Local face detector returned an invalid output tensor.")

    faces: list[dict[str, Any]] = []
    for detection in detections[0, 0]:
        confidence = float(detection[2])
        if not np.isfinite(confidence) or confidence < FACE_CONFIDENCE_THRESHOLD:
            continue

        x1 = max(0, min(width, int(round(float(detection[3]) * width))))
        y1 = max(0, min(height, int(round(float(detection[4]) * height))))
        x2 = max(0, min(width, int(round(float(detection[5]) * width))))
        y2 = max(0, min(height, int(round(float(detection[6]) * height))))
        if x2 <= x1 or y2 <= y1:
            continue

        faces.append({
            "bbox": [x1, y1, x2 - x1, y2 - y1],
            "detection_confidence": round(confidence, 4),
        })

    return sorted(faces, key=lambda face: (face["bbox"][1], face["bbox"][0]))


def estimate_apparent_ages(image_bgr: np.ndarray) -> dict[str, Any]:
    if image_bgr is None or image_bgr.size == 0 or image_bgr.ndim != 3 or image_bgr.shape[2] != 3:
        raise ValueError("Image data is empty or invalid.")

    height, width = image_bgr.shape[:2]
    if width < 40 or height < 40:
        raise ValueError("Image is too small to analyze; minimum image dimensions are 40x40 pixels.")

    face_net, age_net = _get_models()
    detections = _detect_faces(image_bgr, face_net)
    faces: list[dict[str, Any]] = []

    for face_number, detection in enumerate(detections, start=1):
        x, y, face_width, face_height = detection["bbox"]
        crop = image_bgr[y:y + face_height, x:x + face_width]
        quality = assess_face_quality(crop)
        age_range = None

        if quality["can_estimate"]:
            blob = cv2.dnn.blobFromImage(
                crop,
                1.0,
                (227, 227),
                (78.4263377603, 87.7689143744, 114.895847746),
                swapRB=False,
                crop=False,
            )
            try:
                with _age_net_lock:
                    age_net.setInput(blob)
                    scores = np.asarray(age_net.forward(), dtype=np.float64).reshape(-1)
            except cv2.error as exc:
                raise ModelInferenceError(f"Local age model inference failed: {exc}") from exc
            if scores.size != len(AGE_GROUPS) or not np.isfinite(scores).all():
                raise ModelInferenceError(
                    f"Local age model returned {scores.size} finite outputs; expected {len(AGE_GROUPS)}."
                )
            age_range = AGE_GROUPS[int(np.argmax(scores))]

        faces.append({
            "face_number": face_number,
            "bbox": detection["bbox"],
            "detection_confidence": detection["detection_confidence"],
            "quality": {
                "state": quality["state"],
                "metrics": quality["metrics"],
                "observations": quality["observations"],
            },
            "age_status": "estimated" if age_range is not None else "unable_to_estimate",
            "age_range": age_range,
        })

    return {
        "status": "ok",
        "provider": "local_opencv_dnn",
        "model_name": AGE_MODEL_NAME,
        "face_detector_name": FACE_MODEL_NAME,
        "model_version": _model_version(),
        "processed_at": datetime.now(timezone.utc).isoformat(),
        "image_size": {"width": width, "height": height},
        "faces": faces,
        "limitations": LIMITATIONS,
        "message": "Apparent-age groups are model predictions, not verified or actual ages. No gender is inferred.",
    }
