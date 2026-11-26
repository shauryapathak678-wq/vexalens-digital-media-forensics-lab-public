"""Focused tests for EXIF coordinate conversion and no-GPS handling."""

import tempfile
import unittest
from pathlib import Path

from PIL import Image
from PIL.TiffImagePlugin import IFDRational

from gps_tracker import dms_to_decimal, get_gps


class DmsConversionTests(unittest.TestCase):
    def test_known_northern_eastern_coordinate(self) -> None:
        # 40 degrees, 26 minutes, 46 seconds = 40.446111... degrees.
        self.assertAlmostEqual(dms_to_decimal((40, 26, 46), "N"), 40.4461111111)
        self.assertAlmostEqual(dms_to_decimal((79, 58, 56), "E"), 79.9822222222)

    def test_southern_and_western_references_are_negative(self) -> None:
        self.assertAlmostEqual(dms_to_decimal((33, 51, 31), b"S"), -33.8586111111)
        self.assertAlmostEqual(dms_to_decimal((151, 12, 51), b"W"), -151.2141666667)


class MissingGpsTests(unittest.TestCase):
    def test_corrupt_file_returns_none(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            image_path = Path(temporary_directory) / "broken.jpg"
            image_path.write_bytes(b"not an image")
            self.assertIsNone(get_gps(image_path))

    def test_missing_file_returns_none(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            self.assertIsNone(get_gps(Path(temporary_directory) / "missing.jpg"))

    def test_reads_gps_and_available_camera_metadata(self) -> None:
        exif = Image.Exif()
        gps_ifd = exif.get_ifd(0x8825)
        gps_ifd[1] = "N"
        gps_ifd[2] = tuple(IFDRational(value, 1) for value in (40, 26, 46))
        gps_ifd[3] = "W"
        gps_ifd[4] = tuple(IFDRational(value, 1) for value in (79, 58, 56))
        gps_ifd[5] = 0
        gps_ifd[6] = IFDRational(123, 1)
        exif[0x010F] = "Demo Make"
        exif[0x0110] = "Demo Model"
        exif.get_ifd(0x8769)[0x9003] = "2026:11:24 12:00:00"

        with tempfile.TemporaryDirectory() as temporary_directory:
            image_path = Path(temporary_directory) / "with-gps.jpg"
            Image.new("RGB", (12, 12), "blue").save(image_path, exif=exif)

            result = get_gps(image_path)

        self.assertIsNotNone(result)
        assert result is not None
        self.assertAlmostEqual(result["latitude"], 40.4461111111)
        self.assertAlmostEqual(result["longitude"], -79.9822222222)
        self.assertEqual(result["altitude"], 123)
        self.assertEqual(result["date_time"], "2026:11:24 12:00:00")
        self.assertEqual(result["camera_make"], "Demo Make")
        self.assertEqual(result["camera_model"], "Demo Model")


if __name__ == "__main__":
    unittest.main()
