import sys
from types import ModuleType, SimpleNamespace

import cv2
import numpy as np
import pytest

from backend import contrastive_deepfake_detector as detector


def _png_bytes() -> bytes:
    image = np.full((80, 100, 3), 127, dtype=np.uint8)
    success, encoded = cv2.imencode(".png", image)
    assert success
    return encoded.tobytes()


def _mock_retinaface(monkeypatch, detections):
    module = ModuleType("retinaface")
    setattr(module, "RetinaFace", SimpleNamespace(detect_faces=lambda _image: detections))
    monkeypatch.setitem(sys.modules, "retinaface", module)


def test_no_face_returns_no_verdict_without_loading_the_model(monkeypatch):
    monkeypatch.setattr(detector, "_find_largest_face", lambda _image: None)
    monkeypatch.setattr(
        detector,
        "_load_model",
        lambda: pytest.fail("The model should not load when there is no face."),
    )

    result = detector.analyze_image(_png_bytes())

    assert result["assessment"] == "no_face_detected"
    assert result["fake_score"] is None
    assert result["face"] is None
    assert result["model_id"] == detector.MODEL_ID


def test_retinaface_no_face_returns_no_verdict_without_loading_the_model(monkeypatch):
    _mock_retinaface(monkeypatch, {})
    monkeypatch.setattr(
        detector,
        "_load_model",
        lambda: pytest.fail("The model should not load when there is no face."),
    )

    result = detector.analyze_image(_png_bytes())

    assert result["assessment"] == "no_face_detected"
    assert result["fake_score"] is None


def test_retinaface_selects_largest_face_and_clips_its_box(monkeypatch):
    _mock_retinaface(
        monkeypatch,
        {
            "face_1": {"facial_area": [1, 2, 20, 24]},
            "face_2": {"facial_area": [10, 20, 120, 90]},
        },
    )

    face = detector._find_largest_face(np.zeros((80, 100, 3), dtype=np.uint8))

    assert face == (10, 20, 90, 60)


@pytest.mark.parametrize(
    ("score", "assessment", "label"),
    [
        (0.75, "possible_deepfake", "Possible manipulated face"),
        (0.25, "no_strong_signal", "No strong deepfake signal"),
    ],
)
def test_detected_face_returns_model_score_and_scope_limits(monkeypatch, score, assessment, label):
    monkeypatch.setattr(detector, "_find_largest_face", lambda _image: (10, 12, 40, 45))
    monkeypatch.setattr(detector, "_predict_fake_score", lambda _face: score)

    result = detector.analyze_image(_png_bytes())

    assert result["assessment"] == assessment
    assert result["label"] == label
    assert result["fake_score"] == score
    assert result["face"] == {"x": 10, "y": 12, "width": 40, "height": 45}
    assert any("uncalibrated" in limitation for limitation in result["limitations"])


@pytest.mark.parametrize(
    ("image_bytes", "message"),
    [
        (b"", "empty"),
        (b"not an image", "not a readable image"),
    ],
)
def test_invalid_image_is_rejected(image_bytes, message):
    with pytest.raises(ValueError, match=message):
        detector.analyze_image(image_bytes)
