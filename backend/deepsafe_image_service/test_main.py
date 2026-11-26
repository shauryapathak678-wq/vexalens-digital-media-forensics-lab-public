import asyncio
import io
import math
import unittest
from unittest.mock import patch

from fastapi import HTTPException, UploadFile
import httpx
from PIL import Image
from starlette.datastructures import Headers

import main


MODEL_IDS = tuple(main.MODEL_CONFIG)


def completed_result(model_id: str, classification: str) -> dict:
    score = 0.8 if classification == "fake" else 0.2
    return main.normalize_model_result(
        model_id,
        {
            "probability": score,
            "raw_logit": math.log(score / (1 - score)),
            "prediction": int(classification == "fake"),
            "class": classification,
            "inference_time": 0.1,
        },
    )


class DeepSafeImageServiceTests(unittest.TestCase):
    def make_image(self, image_format: str = "PNG") -> bytes:
        image_bytes = io.BytesIO()
        Image.new("RGB", (16, 12), color=(30, 60, 90)).save(image_bytes, format=image_format)
        return image_bytes.getvalue()

    def test_valid_jpeg_and_png_report_dimensions_and_sha256(self) -> None:
        for image_format, mime_type in (("JPEG", "image/jpeg"), ("PNG", "image/png")):
            with self.subTest(image_format=image_format):
                image_bytes = self.make_image(image_format)
                metadata = main.decode_and_inspect_image(image_bytes, mime_type)
                self.assertEqual((metadata["width"], metadata["height"]), (16, 12))
                self.assertEqual(metadata["mime_type"], mime_type)
                self.assertEqual(
                    metadata["sha256"],
                    main.hashlib.sha256(image_bytes).hexdigest(),
                )

    def test_rejects_mismatched_mime_and_pixel_limit(self) -> None:
        with self.assertRaises(HTTPException) as mismatch:
            main.decode_and_inspect_image(self.make_image(), "image/jpeg")
        self.assertEqual(mismatch.exception.status_code, 415)

        with patch.object(main, "MAX_IMAGE_PIXELS", 100):
            with self.assertRaises(HTTPException) as oversized:
                main.decode_and_inspect_image(self.make_image(), "image/png")
        self.assertEqual(oversized.exception.status_code, 413)

    def test_keeps_uncalibrated_score_and_logit_without_threshold_classification(self) -> None:
        result = main.normalize_model_result(
            MODEL_IDS[0],
            {
                "probability": 0.91,
                "raw_logit": math.log(0.91 / 0.09),
                "prediction": 0,
                "class": "real",
            },
        )
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["score"], 0.91)
        self.assertAlmostEqual(result["raw_logit"], math.log(0.91 / 0.09))
        self.assertIsNone(result["classification"])
        self.assertIsNone(result["threshold"])

    def test_rejects_a_score_that_does_not_match_its_reported_logit(self) -> None:
        result = main.normalize_model_result(
            MODEL_IDS[0],
            {"probability": 0.91, "raw_logit": -2.0},
        )
        self.assertEqual(result["status"], "failed")
        self.assertIsNone(result["score"])
        self.assertIn("did not match", result["error"])

    def test_zero_score_is_preserved_as_model_output_not_a_fallback(self) -> None:
        result = main.normalize_model_result(
            MODEL_IDS[0],
            {"probability": 0.0, "raw_logit": -1000.0},
        )
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["score"], 0.0)
        self.assertEqual(result["raw_logit"], -1000.0)
        self.assertIsNone(result["classification"])

    def test_small_sigmoid_score_is_not_rounded_to_zero(self) -> None:
        logit = -20.0
        score = 1.0 / (1.0 + math.exp(-logit))
        result = main.normalize_model_result(
            MODEL_IDS[0],
            {"probability": score, "raw_logit": logit},
        )
        self.assertEqual(result["status"], "completed")
        self.assertGreater(result["score"], 0.0)
        self.assertAlmostEqual(result["score"], 2.0611536181902037e-9)

    def test_ensemble_never_turns_unvalidated_scores_into_a_verdict(self) -> None:
        fake_results = {model_id: completed_result(model_id, "fake") for model_id in MODEL_IDS}
        real_results = {model_id: completed_result(model_id, "real") for model_id in MODEL_IDS}
        disagreement = {
            MODEL_IDS[0]: completed_result(MODEL_IDS[0], "fake"),
            MODEL_IDS[1]: completed_result(MODEL_IDS[1], "real"),
        }
        partial = {
            MODEL_IDS[0]: completed_result(MODEL_IDS[0], "fake"),
            MODEL_IDS[1]: main.failed_model_result(
                MODEL_IDS[1], "unavailable", "Model timed out.", {"error": "timeout"}
            ),
        }
        failed = {
            model_id: main.failed_model_result(
                model_id, "unavailable", "Model timed out.", {"error": "timeout"}
            )
            for model_id in MODEL_IDS
        }

        self.assertEqual(main.build_ensemble(fake_results)["assessment"], "inconclusive")
        self.assertEqual(main.build_ensemble(real_results)["assessment"], "inconclusive")
        self.assertEqual(main.build_ensemble(disagreement)["assessment"], "inconclusive")
        self.assertEqual(main.build_ensemble(partial)["assessment"], "inconclusive")
        self.assertEqual(main.build_ensemble(failed)["assessment"], "analysis_failed")
        self.assertIsNone(main.build_ensemble(fake_results)["fake_votes"])
        self.assertIsNone(main.build_ensemble(fake_results)["total_votes"])
        self.assertIsNone(main.build_ensemble(fake_results)["score"])

    def test_model_requests_start_concurrently(self) -> None:
        async def run_analysis() -> dict:
            both_models_started = asyncio.Event()
            started_models: set[str] = set()

            async def mock_query_model(client, model_id: str, encoded_image: str) -> dict:
                self.assertIsInstance(client, httpx.AsyncClient)
                self.assertTrue(encoded_image)
                started_models.add(model_id)
                if len(started_models) == len(MODEL_IDS):
                    both_models_started.set()
                await asyncio.wait_for(both_models_started.wait(), timeout=0.5)
                return completed_result(model_id, "fake")

            image_file = UploadFile(
                filename="evidence.png",
                file=io.BytesIO(self.make_image()),
                headers=Headers({"content-type": "image/png"}),
            )
            with patch.object(main, "query_model", side_effect=mock_query_model):
                return await main.analyze_image(image_file)

        result = asyncio.run(run_analysis())
        self.assertEqual(result["processing_status"], "completed")
        self.assertEqual(result["ensemble"]["assessment"], "inconclusive")
        self.assertIsNone(result["ensemble"]["total_votes"])

    def test_timed_out_model_is_unavailable_not_a_negative_vote(self) -> None:
        async def run_timeout() -> dict:
            async def slow_model(
                client: httpx.AsyncClient,
                model_id: str,
                encoded_image: str,
            ) -> dict:
                self.assertIsInstance(client, httpx.AsyncClient)
                self.assertEqual(model_id, MODEL_IDS[0])
                self.assertEqual(encoded_image, "image")
                await asyncio.sleep(1)
                return completed_result(model_id, "real")

            with (
                patch.object(main, "MODEL_TIMEOUT_SECONDS", 0.01),
                patch.object(main, "query_model", side_effect=slow_model),
            ):
                async with httpx.AsyncClient() as client:
                    return await main.query_model_with_deadline(client, MODEL_IDS[0], "image")

        result = asyncio.run(run_timeout())
        self.assertEqual(result["status"], "unavailable")
        self.assertIsNone(result["classification"])
        self.assertIn("0.01-second", result["error"])


if __name__ == "__main__":
    unittest.main()
