import hashlib
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.main import app
from backend.genconvit_service import (
    GenConViTInferenceError,
    GenConViTInputError,
    _extract_sampled_faces,
    _predicted_class,
    _rapid_face_search_indices,
    _safe_state_dict,
)
from backend import genconvit_service


class FakeTorch:
    def __init__(self) -> None:
        self.kwargs: dict[str, Any] | None = None

    def load(self, path: Path, **kwargs: Any) -> dict[str, Any]:
        self.kwargs = kwargs
        return {"weight": [1.0]}


class FakeRectangle:
    def left(self) -> int:
        return 10

    def top(self) -> int:
        return 10

    def right(self) -> int:
        return 200

    def bottom(self) -> int:
        return 200


class FakeVideoCapture:
    def __init__(self) -> None:
        self.frame_index = 0
        self.released = False

    def isOpened(self) -> bool:
        return True

    def get(self, property_id: int) -> float:
        if property_id == genconvit_service.cv2.CAP_PROP_FRAME_COUNT:
            return 101
        if property_id == genconvit_service.cv2.CAP_PROP_FPS:
            return 25
        return 0

    def set(self, _property_id: int, value: float) -> None:
        self.frame_index = int(value)

    def read(self) -> tuple[bool, Any]:
        frame = genconvit_service.np.zeros((240, 240, 3), dtype=genconvit_service.np.uint8)
        frame[0, 0, 0] = self.frame_index
        return True, frame

    def release(self) -> None:
        self.released = True


class FakeFaceDetector:
    def __init__(self, face_frames: set[int]) -> None:
        self.face_frames = face_frames
        self.checked_frames: list[int] = []

    def run(self, frame: Any, _upsample: int, _threshold: float) -> tuple[list[Any], list[float], list[float]]:
        frame_index = int(frame[0, 0, 0])
        self.checked_frames.append(frame_index)
        rectangles = [FakeRectangle()] if frame_index in self.face_frames else []
        return rectangles, [], []


class GenConViTServiceTests(unittest.TestCase):
    def test_rapid_face_search_prioritizes_center_then_checks_spread_positions(self) -> None:
        self.assertEqual(_rapid_face_search_indices(101, 5), [50, 25, 75, 0, 100])
        self.assertEqual(_rapid_face_search_indices(3, 5), [1, 0, 2])

    def test_rapid_face_search_recovers_when_center_frame_has_no_face(self) -> None:
        capture = FakeVideoCapture()
        detector = FakeFaceDetector({25})
        with patch("backend.genconvit_service.cv2.VideoCapture", return_value=capture):
            faces, fps, duration, frames_with_faces, frames_scanned = _extract_sampled_faces(
                Path("sample.mp4"),
                detector,
                sample_count=1,
                face_search_count=5,
            )

        self.assertEqual(detector.checked_frames, [50, 25])
        self.assertEqual((fps, duration, frames_with_faces, frames_scanned), (25, 4.04, 1, 2))
        self.assertEqual(len(faces), 1)
        self.assertTrue(capture.released)

    def test_rapid_face_search_reports_no_face_after_all_candidates(self) -> None:
        capture = FakeVideoCapture()
        detector = FakeFaceDetector(set())
        with patch("backend.genconvit_service.cv2.VideoCapture", return_value=capture):
            with patch("backend.genconvit_service._load_fast_model", return_value=(object(), FakeTorch(), detector)):
                with self.assertRaisesRegex(GenConViTInputError, "any of the 5 sampled frames"):
                    genconvit_service.analyze_genconvit_fast_video(Path("sample.mp4"))

        self.assertEqual(len(detector.checked_frames), 5)
        self.assertTrue(capture.released)

    def test_safe_checkpoint_load_uses_weights_only_and_memory_mapping(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            path = Path(temporary_directory) / "checkpoint.pth"
            payload = b"trusted test checkpoint bytes"
            path.write_bytes(payload)
            torch = FakeTorch()

            state = _safe_state_dict(
                torch,
                path,
                len(payload),
                hashlib.sha256(payload).hexdigest(),
            )

        self.assertEqual(state, {"weight": [1.0]})
        self.assertEqual(torch.kwargs, {"map_location": "cpu", "weights_only": True, "mmap": True})

    def test_rejects_checkpoint_hash_mismatch_before_loading(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            path = Path(temporary_directory) / "checkpoint.pth"
            path.write_bytes(b"not the expected checkpoint")
            torch = FakeTorch()

            with self.assertRaisesRegex(GenConViTInferenceError, "SHA-256 verification failed"):
                _safe_state_dict(torch, path, path.stat().st_size, "0" * 64)

        self.assertIsNone(torch.kwargs)

    def test_reported_class_uses_highest_model_score_without_calling_it_confidence(self) -> None:
        self.assertEqual(_predicted_class(0.7, 0.3), "FAKE")
        self.assertEqual(_predicted_class(0.2, 0.8), "REAL")
        with self.assertRaisesRegex(GenConViTInferenceError, "outside the expected range"):
            _predicted_class(1.1, 0.2)

    def test_api_rejects_video_bytes_that_do_not_match_evidence_hash(self) -> None:
        client = TestClient(app)
        response = client.post(
            "/api/genconvit/analyze",
            content=b"not a video",
            headers={
                "Content-Type": "application/octet-stream",
                "X-Evidence-Sha256": "0" * 64,
                "X-File-Extension": ".mp4",
            },
        )
        self.assertEqual(response.status_code, 422)
        self.assertIn("do not match", response.json()["detail"])

    def test_api_rejects_unsupported_video_extension(self) -> None:
        client = TestClient(app)
        response = client.post(
            "/api/genconvit/analyze",
            content=b"not a video",
            headers={
                "Content-Type": "application/octet-stream",
                "X-Evidence-Sha256": "0" * 64,
                "X-File-Extension": ".txt",
            },
        )
        self.assertEqual(response.status_code, 415)

    def test_api_defaults_to_rapid_single_frame_analysis(self) -> None:
        client = TestClient(app)
        payload = b"sample video bytes"
        digest = hashlib.sha256(payload).hexdigest()
        with patch(
            "backend.main.analyze_genconvit_fast_video",
            return_value={"status": "completed", "analysis_mode": "rapid"},
        ) as analyze:
            response = client.post(
                "/api/genconvit/analyze",
                content=payload,
                headers={
                    "Content-Type": "application/octet-stream",
                    "X-Evidence-Sha256": digest,
                    "X-File-Extension": ".mp4",
                },
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["analysis_mode"], "rapid")
        analyze.assert_called_once()

    def test_api_rejects_full_ensemble_that_exceeds_the_50_second_limit(self) -> None:
        client = TestClient(app)
        payload = b"sample video bytes"
        digest = hashlib.sha256(payload).hexdigest()
        with patch("backend.main.analyze_genconvit_fast_video") as analyze:
            response = client.post(
                "/api/genconvit/analyze",
                content=payload,
                headers={
                    "Content-Type": "application/octet-stream",
                    "X-Evidence-Sha256": digest,
                    "X-File-Extension": ".mp4",
                    "X-Analysis-Mode": "full",
                },
            )

        self.assertEqual(response.status_code, 400)
        self.assertIn("exceeded 50 seconds", response.json()["detail"])
        analyze.assert_not_called()

    def test_api_rejects_unknown_analysis_mode(self) -> None:
        client = TestClient(app)
        response = client.post(
            "/api/genconvit/analyze",
            content=b"not a video",
            headers={
                "Content-Type": "application/octet-stream",
                "X-Evidence-Sha256": "0" * 64,
                "X-File-Extension": ".mp4",
                "X-Analysis-Mode": "turbo",
            },
        )
        self.assertEqual(response.status_code, 400)


if __name__ == "__main__":
    unittest.main()
