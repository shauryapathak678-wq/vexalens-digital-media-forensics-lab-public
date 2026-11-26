import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

from modules.lsb_analysis import analyze_lsb_planes


class LsbAnalysisTest(unittest.TestCase):
    def test_extracts_three_planes_and_changes_nothing_about_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "test.png"
            original = np.zeros((4, 4, 3), dtype=np.uint8)
            original[:, :, 0] = np.arange(16, dtype=np.uint8).reshape(4, 4)
            original[:, :, 1] = np.arange(16, dtype=np.uint8).reshape(4, 4) * 2
            original[:, :, 2] = 255
            Image.fromarray(original, "RGB").save(source)
            source_hash = source.read_bytes()

            result = analyze_lsb_planes(source, root / "planes")

            self.assertEqual(set(result.channels), {"red", "green", "blue"})
            self.assertEqual(source.read_bytes(), source_hash)
            for plane_path in result.plane_paths.values():
                self.assertTrue(plane_path.is_file())
            self.assertTrue(result.combined_plane_path.is_file())

    def test_rejects_missing_plane_dimensions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "test.png"
            Image.fromarray(np.full((2, 3, 3), 128, dtype=np.uint8), "RGB").save(source)
            result = analyze_lsb_planes(source, root / "planes")
            self.assertEqual(result.channels["red"].total, 6)


if __name__ == "__main__":
    unittest.main()
