import numpy as np
import pytest

from backend import age_gender_engine as engine


class FakeNet:
    def __init__(self, outputs):
        self.outputs = outputs
        self.forward_count = 0

    def setInput(self, _blob):
        pass

    def forward(self):
        if isinstance(self.outputs, list):
            output = self.outputs[self.forward_count]
            self.forward_count += 1
            return output
        self.forward_count += 1
        return self.outputs


def _image():
    rng = np.random.default_rng(42)
    return rng.integers(30, 220, size=(480, 640, 3), dtype=np.uint8)


def _detections(*boxes):
    rows = [[0, 0, confidence, *box] for confidence, box in boxes]
    return np.asarray(rows, dtype=np.float32).reshape(1, 1, -1, 7)


def _age_scores(class_index):
    scores = np.zeros((1, len(engine.AGE_GROUPS)), dtype=np.float32)
    scores[0, class_index] = 1.0
    return scores


def test_multiple_faces_get_independent_age_groups_and_no_gender(monkeypatch):
    face_net = FakeNet(_detections(
        (0.95, (0.10, 0.10, 0.40, 0.45)),
        (0.91, (0.55, 0.10, 0.85, 0.45)),
    ))
    age_net = FakeNet([_age_scores(4), _age_scores(6)])
    monkeypatch.setattr(engine, "_get_models", lambda: (face_net, age_net))
    monkeypatch.setattr(engine, "_model_version", lambda: "test-local-model-version")

    result = engine.estimate_apparent_ages(_image())

    assert [face["face_number"] for face in result["faces"]] == [1, 2]
    assert [face["age_range"] for face in result["faces"]] == ["25-32 years", "48-53 years"]
    assert [face["bbox"] for face in result["faces"]] == [[64, 48, 192, 168], [352, 48, 192, 168]]
    assert all(face["quality"]["state"] == "good" for face in result["faces"])
    assert all("gender" not in face and "age" not in face for face in result["faces"])
    assert age_net.forward_count == 2
    assert result["model_version"] == "test-local-model-version"
    assert result["processed_at"]


def test_small_face_crop_is_rejected_without_age_inference(monkeypatch):
    face_net = FakeNet(_detections((0.95, (0.10, 0.10, 0.16, 0.19))))
    age_net = FakeNet([_age_scores(2)])
    monkeypatch.setattr(engine, "_get_models", lambda: (face_net, age_net))
    monkeypatch.setattr(engine, "_model_version", lambda: "test-local-model-version")

    result = engine.estimate_apparent_ages(_image())

    assert len(result["faces"]) == 1
    face = result["faces"][0]
    assert face["age_status"] == "unable_to_estimate"
    assert face["age_range"] is None
    assert face["quality"]["state"] == "poor"
    assert "at least 64x64px" in face["quality"]["observations"][0]
    assert age_net.forward_count == 0


def test_no_face_is_returned_when_detector_scores_are_below_threshold(monkeypatch):
    face_net = FakeNet(_detections((0.59, (0.10, 0.10, 0.40, 0.45))))
    age_net = FakeNet([])
    monkeypatch.setattr(engine, "_get_models", lambda: (face_net, age_net))
    monkeypatch.setattr(engine, "_model_version", lambda: "test-local-model-version")

    result = engine.estimate_apparent_ages(_image())

    assert result["faces"] == []
    assert age_net.forward_count == 0


def test_unusable_crop_quality_is_reported_as_poor():
    dark_blurred_crop = np.zeros((128, 128, 3), dtype=np.uint8)

    quality = engine.assess_face_quality(dark_blurred_crop)

    assert quality["state"] == "poor"
    assert quality["can_estimate"] is False
    assert any("too dark" in observation for observation in quality["observations"])
    assert any("angle and occlusion are not assessed" in observation for observation in quality["observations"])


def test_soft_but_measurable_crop_is_moderate_and_still_estimated():
    x = np.arange(128, dtype=np.float32)[None, :]
    grayscale = np.broadcast_to(120 + 30 * np.sin(x * 0.5), (128, 128))
    crop = np.repeat(np.clip(grayscale, 0, 255).astype(np.uint8)[:, :, None], 3, axis=2)

    quality = engine.assess_face_quality(crop)

    assert quality["state"] == "moderate"
    assert quality["can_estimate"] is True


def test_missing_local_weights_raise_a_clear_model_error(monkeypatch, tmp_path):
    monkeypatch.setattr(engine, "MODEL_DIR", tmp_path)
    monkeypatch.setattr(engine, "FACE_CONFIG", tmp_path / "missing-face.prototxt")
    monkeypatch.setattr(engine, "FACE_WEIGHTS", tmp_path / "missing-face.caffemodel")
    monkeypatch.setattr(engine, "AGE_CONFIG", tmp_path / "missing-age.prototxt")
    monkeypatch.setattr(engine, "AGE_WEIGHTS", tmp_path / "missing-age.caffemodel")

    with pytest.raises(engine.ModelUnavailableError, match="model files are missing"):
        engine._load_models()
