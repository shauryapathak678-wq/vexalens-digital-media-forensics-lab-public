import hashlib
import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np
from fastapi.testclient import TestClient

from backend.main import app
from backend.reverse_media_fingerprint import (
    ReverseMediaInputError,
    fingerprint_reverse_media,
)


def encode_image(image: np.ndarray, extension: str, parameters: list[int] | None = None) -> bytes:
    success, encoded = cv2.imencode(extension, image, parameters or [])
    if not success:
        raise RuntimeError(f"Could not encode test image as {extension}.")
    return encoded.tobytes()


def hamming_distance(first: str, second: str) -> int:
    return (int(first, 16) ^ int(second, 16)).bit_count()


class ReverseMediaFingerprintTests(unittest.TestCase):
    def setUp(self) -> None:
        self.image = np.zeros((256, 256, 3), dtype=np.uint8)
        cv2.rectangle(self.image, (18, 18), (112, 112), (20, 50, 210), -1)
        cv2.circle(self.image, (184, 70), 39, (200, 190, 25), -1)
        cv2.line(self.image, (24, 220), (230, 140), (230, 230, 230), 9)
        cv2.putText(self.image, "VEXA", (88, 206), cv2.FONT_HERSHEY_SIMPLEX, 1, (20, 230, 50), 3)

    def test_exact_image_fingerprints_preserve_source_sha256_and_dimensions(self) -> None:
        image_bytes = encode_image(self.image, ".png")

        result = fingerprint_reverse_media(image_bytes, "image/png", "evidence.png")

        self.assertEqual(result["source_sha256"], hashlib.sha256(image_bytes).hexdigest())
        self.assertEqual(result["media_type"], "image")
        self.assertEqual(len(result["frames"]), 1)
        frame = result["frames"][0]
        self.assertEqual((frame["width"], frame["height"]), (256, 256))
        self.assertEqual(len(frame["phash"]), 16)
        self.assertEqual(len(frame["dhash"]), 16)
        self.assertEqual(len(frame["ahash"]), 16)

    def test_perceptual_hash_survives_resize_and_jpeg_compression(self) -> None:
        resized = cv2.resize(self.image, (128, 128), interpolation=cv2.INTER_AREA)
        compressed = encode_image(resized, ".jpg", [cv2.IMWRITE_JPEG_QUALITY, 60])
        original_fingerprint = fingerprint_reverse_media(
            encode_image(self.image, ".png"),
            "image/png",
            "original.png",
        )["frames"][0]
        compressed_fingerprint = fingerprint_reverse_media(
            compressed,
            "image/jpeg",
            "compressed.jpg",
        )["frames"][0]

        self.assertLessEqual(hamming_distance(original_fingerprint["phash"], compressed_fingerprint["phash"]), 6)

    def test_quadrant_crop_fingerprint_matches_the_cropped_image(self) -> None:
        crop = self.image[:128, :128]
        original = fingerprint_reverse_media(
            encode_image(self.image, ".png"),
            "image/png",
            "original.png",
        )["frames"][0]
        cropped = fingerprint_reverse_media(
            encode_image(crop, ".png"),
            "image/png",
            "crop.png",
        )["frames"][0]

        self.assertIn(cropped["phash"], original["crop_phashes"])

    def test_unrelated_images_do_not_share_a_near_identical_phash(self) -> None:
        unrelated = np.zeros((256, 256, 3), dtype=np.uint8)
        for y in range(0, 256, 16):
            cv2.line(unrelated, (0, y), (255, 255 - y), (255, 255, 255), 8)
        first = fingerprint_reverse_media(
            encode_image(self.image, ".png"),
            "image/png",
            "first.png",
        )["frames"][0]
        second = fingerprint_reverse_media(
            encode_image(unrelated, ".png"),
            "image/png",
            "second.png",
        )["frames"][0]

        self.assertGreater(hamming_distance(first["phash"], second["phash"]), 6)

    def test_video_frame_sampling_returns_timestamps_and_provider_derivatives_only_on_consent(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            path = Path(temporary_directory) / "sample.mp4"
            writer = cv2.VideoWriter(
                str(path),
                cv2.VideoWriter_fourcc(*"mp4v"),
                2.0,
                (64, 64),
            )
            if not writer.isOpened():
                self.skipTest("The current OpenCV build has no MP4 test encoder.")
            for index in range(6):
                frame = np.full((64, 64, 3), index * 30, dtype=np.uint8)
                cv2.circle(frame, (32, 32), 8 + index, (255, 255, 255), -1)
                writer.write(frame)
            writer.release()
            video_bytes = path.read_bytes()

        result = fingerprint_reverse_media(
            video_bytes,
            "video/mp4",
            "sample.mp4",
            frame_sample_count=3,
            include_provider_images=True,
        )

        self.assertEqual(result["media_type"], "video")
        self.assertEqual(len(result["frames"]), 3)
        self.assertEqual([frame["timestamp_seconds"] for frame in result["frames"]], [0.0, 1.0, 2.5])
        self.assertTrue(all(frame["provider_image_base64"] for frame in result["frames"]))
        self.assertTrue(all(frame["thumbnail_base64"] for frame in result["frames"]))

    def test_rejects_mime_extension_mismatch_and_invalid_image_data(self) -> None:
        with self.assertRaisesRegex(ReverseMediaInputError, "matching MIME type and extension"):
            fingerprint_reverse_media(b"\x89PNG\r\n\x1a\n", "image/png", "evidence.jpg")
        with self.assertRaisesRegex(ReverseMediaInputError, "could not be decoded"):
            fingerprint_reverse_media(
                b"\x89PNG\r\n\x1a\ninvalid",
                "image/png",
                "evidence.png",
            )


class ReverseMediaFingerprintEndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.client = TestClient(app)
        success, encoded = cv2.imencode(".png", np.zeros((32, 32, 3), dtype=np.uint8))
        if not success:
            raise RuntimeError("Could not encode the endpoint test image.")
        cls.image_bytes = encoded.tobytes()

    def test_endpoint_returns_fingerprint_only_for_matching_evidence_hash(self) -> None:
        digest = hashlib.sha256(self.image_bytes).hexdigest()
        response = self.client.post(
            "/api/reverse-media/fingerprint",
            content=self.image_bytes,
            headers={
                "content-type": "application/octet-stream",
                "x-evidence-sha256": digest,
                "x-file-name": "test.png",
                "x-media-mime-type": "image/png",
                "x-frame-sample-count": "1",
                "x-include-provider-images": "false",
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["source_sha256"], digest)

    def test_endpoint_rejects_an_evidence_hash_mismatch(self) -> None:
        response = self.client.post(
            "/api/reverse-media/fingerprint",
            content=self.image_bytes,
            headers={
                "content-type": "application/octet-stream",
                "x-evidence-sha256": "0" * 64,
                "x-file-name": "test.png",
                "x-media-mime-type": "image/png",
                "x-frame-sample-count": "1",
            },
        )

        self.assertEqual(response.status_code, 422)

    def test_backend_health_advertises_the_reverse_media_capability(self) -> None:
        response = self.client.get("/api/ela/health")

        self.assertEqual(response.status_code, 200)
        self.assertIn("reverse_media_fingerprint", response.json()["features"])
        self.assertIn("video_genealogy", response.json()["features"])
        self.assertIn("image_trace", response.json()["features"])


if __name__ == "__main__":
    unittest.main()
