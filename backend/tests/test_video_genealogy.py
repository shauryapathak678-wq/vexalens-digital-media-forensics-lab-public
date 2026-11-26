import json
import hashlib
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import cv2
import numpy as np
from fastapi.testclient import TestClient

from backend.main import app
from backend.video_genealogy import (
    VideoGenealogyInputError,
    _frame_fingerprint,
    _audio_hashes,
    _sequence_similarity,
    _search_sources,
    _youtube_search,
    analyze_video_set,
)


def create_clip(path: Path, frames: list[np.ndarray], fps: float = 4.0) -> bytes:
    writer = cv2.VideoWriter(
        str(path),
        cv2.VideoWriter_fourcc(*"MJPG"),
        fps,
        (160, 120),
    )
    if not writer.isOpened():
        raise RuntimeError("The installed OpenCV build could not create the AVI test clip.")
    for frame in frames:
        writer.write(frame)
    writer.release()
    return path.read_bytes()


def make_frames(frame_count: int, variation: int = 0) -> list[np.ndarray]:
    frames = []
    for index in range(frame_count):
        frame = np.zeros((120, 160, 3), dtype=np.uint8)
        cv2.rectangle(frame, (8 + variation, 10), (70 + variation, 80), (30, 180, 230), -1)
        cv2.circle(frame, (20 + (index * 5) % 115, 91), 11, (240, 240, 240), -1)
        cv2.line(frame, (5, 110), (150, 8 + (index * 3) % 90), (50, 225, 75), 3)
        cv2.putText(frame, str(index % 10), (112, 55), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)
        frames.append(frame)
    return frames


class VideoGenealogyAlgorithmTests(unittest.TestCase):
    def test_hash_sizes_produce_the_configured_number_of_bits(self) -> None:
        frame = make_frames(1)[0]
        for hash_bits in (64, 256, 1024):
            fingerprint = _frame_fingerprint(frame, hash_bits)
            self.assertTrue(all(len(item) == hash_bits // 4 for item in fingerprint["hashes"]))

    def test_matching_temporal_versions_cluster_and_persist_locally(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            folder = Path(temporary_directory)
            reference = folder / "reference.avi"
            candidate = folder / "candidate.avi"
            source_frames = make_frames(32)
            reference_bytes = create_clip(reference, source_frames, fps=4.0)
            transformed_frames = []
            for source_frame in source_frames[::2]:
                cropped = source_frame[10:-10, 12:-12]
                transformed = cv2.resize(cropped, (160, 120), interpolation=cv2.INTER_CUBIC)
                transformed = cv2.convertScaleAbs(transformed, alpha=0.9, beta=18)
                cv2.putText(
                    transformed,
                    "NEWS",
                    (112, 18),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.4,
                    (255, 255, 255),
                    1,
                )
                transformed_frames.append(transformed)
            candidate_bytes = create_clip(candidate, transformed_frames, fps=2.0)
            database = folder / "genealogy.sqlite3"

            with patch.dict("os.environ", {"VEXALENS_VIDEO_GENEALOGY_DB": str(database)}):
                result = analyze_video_set(
                    [reference, candidate],
                    ["reference.avi", "candidate.avi"],
                    256,
                    False,
                    "",
                )

            self.assertEqual(result["hash_bits"], 256)
            self.assertEqual(result["files"][0]["sha256"], hashlib.sha256(reference_bytes).hexdigest())
            self.assertEqual(result["files"][1]["sha256"], hashlib.sha256(candidate_bytes).hexdigest())
            self.assertGreaterEqual(result["comparisons"][0]["visual_similarity"], 60)
            self.assertEqual(len(result["clusters"]), 1)
            self.assertEqual(len(result["clusters"][0]["tree_edges"]), 1)
            self.assertEqual(result["persistence"], "local_sqlite")
            self.assertTrue(database.exists())
            with closing(sqlite3.connect(database)) as connection, connection:
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM media_fingerprints").fetchone()[0], 2)
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM genealogy_audit_log").fetchone()[0], 1)

    def test_blank_frames_do_not_create_a_high_confidence_match(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            folder = Path(temporary_directory)
            first = folder / "blank_a.avi"
            second = folder / "blank_b.avi"
            database = folder / "blank-test.sqlite3"
            blank = np.zeros((120, 160, 3), dtype=np.uint8)
            create_clip(first, [blank] * 16)
            white = np.full((120, 160, 3), 255, dtype=np.uint8)
            create_clip(second, [white] * 16)
            with patch.dict("os.environ", {"VEXALENS_VIDEO_GENEALOGY_DB": str(database)}):
                result = analyze_video_set(
                    [first, second],
                    ["blank_a.avi", "blank_b.avi"],
                    256,
                    False,
                    "",
                    persist=False,
                )
        self.assertEqual(result["comparisons"][0]["visual_similarity"], 0)
        self.assertEqual(len(result["clusters"]), 2)

    def test_audio_hashes_compare_overlapping_spectral_windows(self) -> None:
        sample_rate = 8000
        times = np.arange(sample_rate * 6, dtype=np.float32) / sample_rate
        samples = np.rint(np.sin(2 * np.pi * 440 * times) * 10000).astype("<i2")
        fingerprints = _audio_hashes(samples, 256)
        comparison = _sequence_similarity(fingerprints, fingerprints, 256, 0.30, False)
        self.assertGreaterEqual(len(fingerprints), 4)
        self.assertIsNotNone(comparison)
        self.assertEqual(comparison["score"], 100)

    def test_custom_source_links_are_not_fetched_and_reject_non_https_urls(self) -> None:
        links = ["https://example.test/clip/123"]
        result = _search_sources("", False, links)
        self.assertEqual(result["status"], "links_only")
        self.assertEqual(result["custom_links"][0]["url"], links[0])
        with self.assertRaisesRegex(VideoGenealogyInputError, "valid HTTPS links"):
            _search_sources("", False, ["http://127.0.0.1/private"])

    def test_youtube_search_is_skipped_when_online_search_is_not_enabled(self) -> None:
        with patch("backend.video_genealogy._youtube_search") as youtube_search:
            result = _search_sources("", False, [])
        youtube_search.assert_not_called()
        self.assertEqual(result["status"], "not_requested")

    def test_youtube_search_returns_links_without_downloading_video_content(self) -> None:
        payload = {
            "entries": [
                {"id": "test123", "title": "Sample interview", "uploader": "Example channel", "duration": 30},
                {"id": "javascript:alert(1)", "title": "Ignored malicious result"},
            ]
        }
        with patch(
            "backend.video_genealogy.subprocess.run",
            return_value=SimpleNamespace(returncode=0, stdout=json.dumps(payload), stderr=""),
        ) as run:
            result = _youtube_search("sample query")
        command = run.call_args.args[0]
        self.assertIn("--skip-download", command)
        self.assertEqual(len(result["candidates"]), 1)
        self.assertEqual(result["candidates"][0]["url"], "https://www.youtube.com/watch?v=test123")


class VideoGenealogyEndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.client = TestClient(app)
        cls.temporary_directory = tempfile.TemporaryDirectory()
        cls.video_path = Path(cls.temporary_directory.name) / "reference.avi"
        cls.video_bytes = create_clip(cls.video_path, make_frames(32), fps=4.0)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.temporary_directory.cleanup()

    def _post(self, digest: str):
        return self.client.post(
            "/api/video-genealogy/analyze",
            files=[
                ("root", ("reference.avi", self.video_bytes, "video/x-msvideo")),
                ("root_sha256", (None, digest)),
                ("hash_bits", (None, "256")),
                ("online_search", (None, "false")),
            ],
        )

    def test_endpoint_returns_custody_checked_fingerprint(self) -> None:
        digest = hashlib.sha256(self.video_bytes).hexdigest()
        with tempfile.TemporaryDirectory() as temporary_directory:
            database = Path(temporary_directory) / "endpoint.sqlite3"
            with patch.dict("os.environ", {"VEXALENS_VIDEO_GENEALOGY_DB": str(database)}):
                response = self._post(digest)
            self.assertTrue(database.exists())
        self.assertEqual(response.status_code, 200, response.text)
        file_result = response.json()["files"][0]
        self.assertEqual(file_result["sha256"], digest)
        self.assertTrue(file_result["custody"]["original_unchanged"])

    def test_endpoint_compares_reference_against_prior_local_fingerprints(self) -> None:
        digest = hashlib.sha256(self.video_bytes).hexdigest()
        with tempfile.TemporaryDirectory() as temporary_directory:
            database = Path(temporary_directory) / "local-search.sqlite3"
            with patch.dict("os.environ", {"VEXALENS_VIDEO_GENEALOGY_DB": str(database)}):
                initial = self._post(digest)
                follow_up = self._post(digest)
        self.assertEqual(initial.status_code, 200, initial.text)
        self.assertEqual(initial.json()["local_database_matches"], [])
        self.assertEqual(follow_up.status_code, 200, follow_up.text)
        matches = follow_up.json()["local_database_matches"]
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0]["match_confidence"], 100)

    def test_endpoint_rejects_mismatched_browser_hash(self) -> None:
        response = self._post("0" * 64)
        self.assertEqual(response.status_code, 422)


if __name__ == "__main__":
    unittest.main()
