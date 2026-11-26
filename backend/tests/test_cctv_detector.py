import hashlib
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.cctv_detector import analyze_video
from backend.main import app


PROJECT_ROOT = Path(__file__).resolve().parents[2]
CCTV_SAMPLES = PROJECT_ROOT / "public" / "samples" / "cctv"


class CctvDetectorSampleTests(unittest.TestCase):
    def test_clean_sample_has_no_tampering_indicators(self) -> None:
        result = analyze_video(CCTV_SAMPLES / "cctv_clean.mp4")

        self.assertEqual(result["verdict"], "No tampering indicators found")
        self.assertEqual(result["timing_gaps"], [])
        self.assertEqual(result["discontinuities"], [])
        self.assertEqual(result["frozen_frames"], [])
        self.assertEqual(result["replayed_segments"], [])

    def test_gap_sample_uses_opencv_timestamps_to_find_missing_frames(self) -> None:
        result = analyze_video(CCTV_SAMPLES / "cctv_gap.mp4")

        self.assertEqual(result["file"]["timestamp_source"], "opencv")
        self.assertTrue(result["timing_gaps"])

    def test_replay_sample_reports_a_replayed_segment(self) -> None:
        result = analyze_video(CCTV_SAMPLES / "cctv_replay.mp4")

        self.assertTrue(result["replayed_segments"])
        self.assertGreaterEqual(result["risk_score"], 45)

    def test_frame_limit_returns_a_marked_partial_result(self) -> None:
        result = analyze_video(CCTV_SAMPLES / "cctv_clean.mp4", max_frames=20, max_seconds=60)

        self.assertEqual(result["file"]["frames_analyzed"], 20)
        self.assertTrue(result["file"]["truncated"])


class CctvDetectorEndpointTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(app)
        self.payload = b"synthetic video bytes"
        self.sha256 = hashlib.sha256(self.payload).hexdigest()
        self.headers = {
            "Content-Type": "application/octet-stream",
            "X-Evidence-Sha256": self.sha256,
            "X-File-Extension": ".mp4",
        }

    def test_endpoint_checks_original_hash_and_returns_copy_hashes(self) -> None:
        def fake_analyze(path: Path) -> dict:
            copied_hash = hashlib.sha256(path.read_bytes()).hexdigest()
            return {"verdict": "No tampering indicators found", "file": {"sha256": copied_hash}}

        with patch("backend.main.analyze_cctv_video", side_effect=fake_analyze):
            response = self.client.post("/api/cctv/analyze", content=self.payload, headers=self.headers)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["custody"], {
            "source_sha256": self.sha256,
            "analysis_sha256": self.sha256,
            "original_unchanged": True,
        })

    def test_endpoint_rejects_mismatched_hash_before_analysis(self) -> None:
        with patch("backend.main.analyze_cctv_video") as analyze:
            response = self.client.post(
                "/api/cctv/analyze",
                content=self.payload,
                headers={**self.headers, "X-Evidence-Sha256": "0" * 64},
            )

        self.assertEqual(response.status_code, 422)
        analyze.assert_not_called()

    def test_endpoint_rejects_unsupported_extensions(self) -> None:
        response = self.client.post(
            "/api/cctv/analyze",
            content=self.payload,
            headers={**self.headers, "X-File-Extension": ".txt"},
        )

        self.assertEqual(response.status_code, 415)

    def test_endpoint_rejects_when_analysis_copy_changes(self) -> None:
        def mutate_copy(path: Path) -> dict:
            path.write_bytes(b"modified copy")
            return {"verdict": "No tampering indicators found", "file": {"sha256": self.sha256}}

        with patch("backend.main.analyze_cctv_video", side_effect=mutate_copy):
            response = self.client.post("/api/cctv/analyze", content=self.payload, headers=self.headers)

        self.assertEqual(response.status_code, 500)
        self.assertIn("copy changed", response.json()["detail"])


if __name__ == "__main__":
    unittest.main()
