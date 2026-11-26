"""Synthetic, dependency-local tests for the ELA engine."""

import io

import numpy as np
from PIL import Image, ImageDraw

from backend.ela_engine import perform_ela


WIDTH = HEIGHT = 640
PATCH = (224, 224, 150, 150)


def _natural_rgb(seed: int = 22) -> Image.Image:
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:HEIGHT, 0:WIDTH]
    smooth = (
        112
        + 28 * np.sin(x / 37)
        + 22 * np.cos(y / 53)
        + 14 * np.sin((x + y) / 81)
    )
    pixels = np.empty((HEIGHT, WIDTH, 3), dtype=np.uint8)
    pixels[:, :, 0] = np.clip(smooth + rng.normal(0, 3, (HEIGHT, WIDTH)), 0, 255)
    pixels[:, :, 1] = np.clip(smooth * 0.83 + 24 + rng.normal(0, 3, (HEIGHT, WIDTH)), 0, 255)
    pixels[:, :, 2] = np.clip(smooth * 0.68 + 42 + rng.normal(0, 3, (HEIGHT, WIDTH)), 0, 255)
    return Image.fromarray(pixels, "RGB")


def _camera_exif() -> bytes:
    exif = Image.Exif()
    exif[271] = "Synthetic Camera"
    exif[272] = "Test Model"
    exif[305] = "Camera Firmware"
    exif[306] = "2026:11:12 12:00:00"
    return exif.tobytes()


def _encode(image: Image.Image, quality: int, exif: bytes = b"") -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, "JPEG", quality=quality, exif=exif)
    return buffer.getvalue()


def _edited_jpeg() -> bytes:
    base = Image.open(io.BytesIO(_encode(_natural_rgb(), 95, _camera_exif()))).convert("RGB")
    rng = np.random.default_rng(1337)
    patch = np.empty((PATCH[3], PATCH[2], 3), dtype=np.uint8)
    texture = rng.integers(30, 226, (PATCH[3], PATCH[2]), dtype=np.uint8)
    patch[:, :, 0] = texture
    patch[:, :, 1] = np.roll(texture, 13, axis=1)
    patch[:, :, 2] = np.roll(texture, 29, axis=0)
    base.paste(Image.fromarray(patch, "RGB"), (PATCH[0], PATCH[1]))
    return _encode(base, 78, _camera_exif())


def _wholly_recompressed_jpeg() -> bytes:
    rng = np.random.default_rng(77)
    source = Image.fromarray(rng.integers(0, 256, (HEIGHT, WIDTH, 3), dtype=np.uint8), "RGB")
    once = Image.open(io.BytesIO(_encode(source, 95, _camera_exif()))).convert("RGB")
    return _encode(once, 78, _camera_exif())


def test_original_camera_jpeg_at_quality_95_has_no_hotspots():
    result = perform_ela(_encode(_natural_rgb(), 95, _camera_exif()), file_name="camera.jpg")

    assert result["reliability"] == "high"
    assert result["ela_verdict"] == "no_local_edits_detected"
    assert result["hotspots"] == []
    assert result["quality"] == 95


def test_pasted_different_texture_is_localized_to_patch():
    result = perform_ela(_edited_jpeg(), file_name="edited.jpg")

    assert result["ela_verdict"] == "possible_local_edit"
    assert len(result["hotspots"]) == 1
    hotspot = result["hotspots"][0]
    patch_x, patch_y, patch_w, patch_h = PATCH
    assert hotspot["x"] < patch_x + patch_w
    assert hotspot["x"] + hotspot["w"] > patch_x
    assert hotspot["y"] < patch_y + patch_h
    assert hotspot["y"] + hotspot["h"] > patch_y
    assert hotspot["x"] > 0 or hotspot["y"] > 0
    assert hotspot["w"] < WIDTH or hotspot["h"] < HEIGHT


def test_png_is_not_reliable_for_ela():
    buffer = io.BytesIO()
    _natural_rgb().save(buffer, "PNG")

    result = perform_ela(buffer.getvalue(), file_name="screenshot.png")

    assert result["reliability"] == "low"
    assert result["ela_verdict"] == "not_reliable"
    assert any("not JPEG" in reason for reason in result["reliability_reasons"])


def test_whatsapp_filename_and_missing_exif_are_low_reliability():
    result = perform_ela(
        _encode(_natural_rgb(), 90),
        file_name="WhatsApp Image 2026-11-12.jpeg",
    )

    assert result["reliability"] == "low"
    assert result["ela_verdict"] == "not_reliable"
    assert result["exif_summary"]["hasExif"] is False
    assert result["hotspots"] == []
    assert any("WhatsApp" in reason for reason in result["reliability_reasons"])
    assert any("No EXIF" in reason for reason in result["reliability_reasons"])


def test_uniform_recompression_is_global_and_has_no_hotspots():
    result = perform_ela(_wholly_recompressed_jpeg(), file_name="resaved_camera.jpg")

    assert result["reliability"] == "high"
    assert result["ela_verdict"] == "global_recompression"
    assert result["hotspots"] == []
    assert result["is_global_pattern"] is True


def test_no_peak_pixel_spike_or_full_frame_hotspot_is_returned():
    result = perform_ela(_encode(_natural_rgb(), 95, _camera_exif()), file_name="camera.jpg")
    serialized = repr(result)

    assert "+1290%" not in serialized
    assert "spike" not in serialized.lower()
    for hotspot in result["hotspots"]:
        assert not (
            hotspot["x"] == 0 and hotspot["y"] == 0
            and hotspot["w"] == result["width"] and hotspot["h"] == result["height"]
        )


def test_ai_origin_without_metadata_is_reported_as_none_found():
    result = perform_ela(_encode(_natural_rgb(), 95, _camera_exif()), file_name="camera.jpg")

    assert result["ai_origin"]["status"] == "none_found"
    assert "No AI-origin signals found in metadata" in result["ai_origin_details"]
    assert "does NOT prove the image is real" in result["ai_origin_details"]

