import io

import numpy as np
import pytest
from PIL import Image, ImageDraw

from backend.screenshot_engine import analyze_screenshot


def encode_image(image: Image.Image, format_name: str) -> bytes:
    output = io.BytesIO()
    image.save(output, format=format_name)
    return output.getvalue()


def make_ui_screenshot() -> Image.Image:
    image = Image.new("RGB", (480, 640), "#f7f8fa")
    draw = ImageDraw.Draw(image)
    draw.rectangle((24, 24, 456, 106), fill="#ffffff", outline="#d6dbe2", width=2)
    draw.rectangle((24, 130, 456, 290), fill="#ffffff", outline="#d6dbe2", width=2)
    draw.rectangle((24, 316, 456, 460), fill="#ffffff", outline="#d6dbe2", width=2)
    for row in range(8):
        y = 150 + row * 16
        draw.line((44, y, 250 + (row % 3) * 28, y), fill="#667085", width=2)
    draw.text((44, 44), "TRANSFER COMPLETE", fill="#182230")
    draw.text((44, 326), "Reference number", fill="#182230")
    return image


def make_copy_move_fixture() -> Image.Image:
    image = Image.new("RGB", (480, 640), "#f5f5f5")
    draw = ImageDraw.Draw(image)
    rng = np.random.default_rng(42)
    colors = ["#122b4a", "#b42318", "#067647", "#7a5af8", "#dc6803"]
    for index in range(90):
        x = int(rng.integers(30, 150))
        y = int(rng.integers(170, 290))
        radius = int(rng.integers(2, 9))
        color = colors[index % len(colors)]
        if index % 2:
            draw.ellipse((x - radius, y - radius, x + radius, y + radius), outline=color, width=2)
        else:
            draw.line((x - radius, y - radius, x + radius, y + radius), fill=color, width=2)
    patch = image.crop((20, 150, 170, 310))
    image.paste(patch, (260, 360))
    return image


def test_png_analysis_does_not_run_jpeg_ela_or_invent_scores(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("TESSERACT_CMD", raising=False)
    image_bytes = encode_image(make_ui_screenshot(), "PNG")

    result = analyze_screenshot(image_bytes, "transaction.png", "payment")

    assert result["imageDimensions"] == {"width": 480, "height": 640}
    assert result["sha256"]
    assert result["moduleFindings"]["compressionEla"]["status"] == "not_applicable"
    assert "overallScore" not in result
    assert all("confidenceScore" not in region for region in result["suspiciousRegions"])
    assert result["moduleFindings"]["ocrLayout"]["status"] == "not_applicable"
    assert result["moduleOverlayDataUrls"] == {}


def test_jpeg_analysis_records_ela_threshold_and_actual_measurements(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("TESSERACT_CMD", raising=False)
    image_bytes = encode_image(make_ui_screenshot(), "JPEG")

    result = analyze_screenshot(image_bytes, "transfer.jpg", "upi", sensitivity=4)

    ela = result["moduleFindings"]["compressionEla"]
    assert ela["thresholds"]["jpeg_quality"] == 75
    assert ela["thresholds"]["sensitivity_1_to_5"] == 4
    assert ela["metrics"]["tile_count"] > 0
    assert result["moduleFindings"]["imageBoundary"]["metrics"]["jpeg_grid_ratio"] >= 0
    assert result["parameters"]["engine"] == "2.0.0-opencv"


def test_copy_move_overlay_coordinates_come_from_feature_matching(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("TESSERACT_CMD", raising=False)
    image_bytes = encode_image(make_copy_move_fixture(), "PNG")

    result = analyze_screenshot(image_bytes, "duplicated-region.png")

    copy_move = result["moduleFindings"]["copyMove"]
    assert copy_move["metrics"]["keypoint_count"] > 0
    assert copy_move["metrics"]["displacement_clusters"] > 0
    assert any("copyMove" in region["modules"] for region in result["suspiciousRegions"])
    assert "copyMove" in result["moduleOverlayDataUrls"]


def test_rejects_bad_sensitivity_and_non_image_payload() -> None:
    with pytest.raises(ValueError, match="Sensitivity"):
        analyze_screenshot(b"not an image", sensitivity=9)

    with pytest.raises(ValueError, match="valid, readable image"):
        analyze_screenshot(b"not an image", sensitivity=3)
