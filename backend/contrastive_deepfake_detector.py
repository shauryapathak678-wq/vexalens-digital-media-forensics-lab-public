"""Local face deepfake inference using the nikokons EfficientNet-B4 checkpoint."""

from __future__ import annotations

import threading
from typing import Any

import cv2
import numpy as np

MODEL_ID = "nikokons/contrastive-deepfake-detector"
MODEL_REVISION = "1fd2a03be393460bf9f6024e722f4a1daf45f4a1"
MODEL_FILE = "79_0.9980_val.tar"
MODEL_URL = f"https://huggingface.co/{MODEL_ID}"
INPUT_SIZE = 380
MAX_IMAGE_BYTES = 25 * 1024 * 1024
MAX_IMAGE_PIXELS = 30_000_000
FAKE_SCORE_THRESHOLD = 0.5

_model: Any | None = None
_torch: Any | None = None
_device: Any | None = None
_model_lock = threading.Lock()


class ModelUnavailableError(RuntimeError):
    """Raised when the model runtime or checkpoint cannot be loaded."""


def _find_largest_face(image_bgr: np.ndarray) -> tuple[int, int, int, int] | None:
    try:
        from retinaface import RetinaFace
    except ImportError as error:
        raise ModelUnavailableError(
            "The local RetinaFace detector dependency is missing. "
            "Install backend/requirements.txt and restart the backend."
        ) from error

    detections = RetinaFace.detect_faces(image_bgr)
    if not isinstance(detections, dict):
        raise RuntimeError("RetinaFace returned an invalid detection response.")
    if not detections:
        return None

    image_height, image_width = image_bgr.shape[:2]
    boxes: list[tuple[int, int, int, int]] = []
    for detection in detections.values():
        if not isinstance(detection, dict):
            raise RuntimeError("RetinaFace returned an invalid face detection.")
        face_area = detection.get("facial_area")
        if not isinstance(face_area, (list, tuple, np.ndarray)) or len(face_area) != 4:
            raise RuntimeError("RetinaFace returned an invalid face bounding box.")
        if not np.issubdtype(np.asarray(face_area).dtype, np.number):
            raise RuntimeError("RetinaFace returned a non-numeric face bounding box.")
        if not np.isfinite(face_area).all():
            raise RuntimeError("RetinaFace returned a non-finite face bounding box.")

        x1, y1, x2, y2 = (int(value) for value in face_area)
        x1 = max(0, min(image_width, x1))
        y1 = max(0, min(image_height, y1))
        x2 = max(x1, min(image_width, x2))
        y2 = max(y1, min(image_height, y2))
        if x2 > x1 and y2 > y1:
            boxes.append((x1, y1, x2 - x1, y2 - y1))

    if not boxes:
        raise RuntimeError("RetinaFace did not return a valid face bounding box.")
    return max(boxes, key=lambda box: box[2] * box[3])


def _load_model() -> tuple[Any, Any, Any]:
    global _model, _torch, _device
    if _model is not None and _torch is not None and _device is not None:
        return _model, _torch, _device

    with _model_lock:
        if _model is not None and _torch is not None and _device is not None:
            return _model, _torch, _device

        try:
            import torch
            from efficientnet_pytorch import EfficientNet
            from huggingface_hub import hf_hub_download
        except ImportError as error:
            raise ModelUnavailableError(
                "The local deepfake model dependencies are missing. "
                "Install backend/requirements.txt and restart the backend."
            ) from error

        class FeatureExtractor(torch.nn.Module):
            def __init__(self) -> None:
                super().__init__()
                self.efficient_net = EfficientNet.from_name("efficientnet-b4")
                self.efficient_net._fc = torch.nn.Identity()

            def forward(self, image: Any) -> Any:
                return self.efficient_net.extract_features(image)

        class Detector(torch.nn.Module):
            def __init__(self) -> None:
                super().__init__()
                self.global_feature_extractor = FeatureExtractor()
                self.global_pool = torch.nn.AdaptiveAvgPool2d(1)
                self.classifier = torch.nn.Linear(1792, 2)

            def forward(self, image: Any) -> Any:
                features = self.global_feature_extractor(image)
                pooled = self.global_pool(features).view(features.size(0), -1)
                return self.classifier(pooled)

        try:
            checkpoint_path = hf_hub_download(
                repo_id=MODEL_ID,
                filename=MODEL_FILE,
                revision=MODEL_REVISION,
            )
            checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=True)
            state_dict = checkpoint.get("model") if isinstance(checkpoint, dict) else None
            if not isinstance(state_dict, dict):
                raise ValueError("The downloaded checkpoint does not contain a model state dictionary.")

            model = Detector()
            model.load_state_dict(state_dict)
            device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
            model.to(device)
            model.eval()
        except Exception as error:
            raise ModelUnavailableError(
                f"Could not load the Hugging Face model checkpoint: {error}"
            ) from error

        _model, _torch, _device = model, torch, device
        return model, torch, device


def _predict_fake_score(face_bgr: np.ndarray) -> float:
    model, torch, device = _load_model()
    face_rgb = cv2.cvtColor(face_bgr, cv2.COLOR_BGR2RGB)
    resized = cv2.resize(face_rgb, (INPUT_SIZE, INPUT_SIZE), interpolation=cv2.INTER_AREA)
    tensor = torch.from_numpy(resized.copy()).permute(2, 0, 1).float().div(255.0).unsqueeze(0)
    tensor = tensor.to(device)

    with torch.inference_mode():
        logits = model(tensor)
        fake_score = float(torch.softmax(logits, dim=1)[0, 1].item())
    if not np.isfinite(fake_score) or not 0 <= fake_score <= 1:
        raise RuntimeError("The deepfake model returned an invalid score.")
    return fake_score


def analyze_image(image_bytes: bytes) -> dict[str, Any]:
    if not image_bytes:
        raise ValueError("The uploaded image is empty.")
    if len(image_bytes) > MAX_IMAGE_BYTES:
        raise ValueError("The image exceeds the 25 MB local analysis limit.")

    encoded = np.frombuffer(image_bytes, dtype=np.uint8)
    image_bgr = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
    if image_bgr is None:
        raise ValueError("The uploaded file is not a readable image.")
    height, width = image_bgr.shape[:2]
    if width * height > MAX_IMAGE_PIXELS:
        raise ValueError("The image exceeds the 30-megapixel local analysis limit.")

    face_box = _find_largest_face(image_bgr)
    if face_box is None:
        return {
            "assessment": "no_face_detected",
            "label": "No face detected",
            "fake_score": None,
            "face": None,
            "model_id": MODEL_ID,
            "model_url": MODEL_URL,
            "limitations": [
                "This detector is intended for manipulated face images, not general AI-generated imagery.",
                "No verdict is available because the local face detector found no face.",
            ],
        }

    x, y, face_width, face_height = face_box
    face = image_bgr[y:y + face_height, x:x + face_width]
    if face.size == 0:
        raise RuntimeError("The face detector returned an invalid face region.")

    fake_score = _predict_fake_score(face)
    is_possible_deepfake = fake_score >= FAKE_SCORE_THRESHOLD
    return {
        "assessment": "possible_deepfake" if is_possible_deepfake else "no_strong_signal",
        "label": "Possible manipulated face" if is_possible_deepfake else "No strong deepfake signal",
        "fake_score": fake_score,
        "face": {"x": x, "y": y, "width": face_width, "height": face_height},
        "model_id": MODEL_ID,
        "model_url": MODEL_URL,
        "limitations": [
            "The model targets manipulated face images and is not a general AI-image detector.",
            "The reported fake score is an uncalibrated model output, not a probability of authenticity.",
            "This integration uses RetinaFace bounding boxes; exact crop alignment may still differ from the training pipeline.",
            "A low score does not prove that the image is real, original, or unedited.",
        ],
    }
