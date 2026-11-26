"""Reproducible synthetic smoke benchmark; not a field-accuracy study."""

from __future__ import annotations

import io
import json
from dataclasses import dataclass

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from backend.screenshot_engine import analyze_screenshot


@dataclass
class Fixture:
    name: str
    expected_edit: bool
    image: Image.Image
    format_name: str = "PNG"


def _encode(image: Image.Image, format_name: str, quality: int = 90) -> bytes:
    buffer = io.BytesIO()
    options = {"quality": quality} if format_name == "JPEG" else {}
    image.save(buffer, format=format_name, **options)
    return buffer.getvalue()


def _base_screenshot() -> Image.Image:
    image = Image.new("RGB", (480, 640), "#f7f8fa")
    draw = ImageDraw.Draw(image)
    draw.rectangle((24, 24, 456, 106), fill="#ffffff", outline="#d6dbe2", width=2)
    draw.text((42, 48), "PAYMENT SUCCESSFUL", fill="#182230", font=ImageFont.load_default())
    draw.rectangle((24, 130, 456, 300), fill="#ffffff", outline="#d6dbe2", width=2)
    draw.text((42, 150), "Paid to", fill="#667085", font=ImageFont.load_default())
    draw.text((42, 177), "RAHUL KUMAR", fill="#182230", font=ImageFont.load_default())
    draw.text((300, 225), "Rs 1,250", fill="#182230", font=ImageFont.load_default())
    draw.rectangle((24, 325, 456, 460), fill="#ffffff", outline="#d6dbe2", width=2)
    draw.text((42, 345), "Reference number", fill="#667085", font=ImageFont.load_default())
    draw.text((42, 372), "108734562910", fill="#182230", font=ImageFont.load_default())
    for row in range(8):
        y = 160 + row * 16
        draw.line((42, y, 250 + (row % 3) * 28, y), fill="#e2e5e9", width=1)
    return image


def _copy_move() -> Image.Image:
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
    image.paste(image.crop((20, 150, 170, 310)), (260, 360))
    return image


def fixtures() -> list[Fixture]:
    original = _base_screenshot()

    amount = original.copy()
    draw = ImageDraw.Draw(amount)
    draw.rectangle((292, 218, 418, 250), fill="#ffffff")
    draw.text((300, 225), "Rs 9,850", fill="#182230", font=ImageFont.load_default())

    name = original.copy()
    draw = ImageDraw.Draw(name)
    draw.rectangle((38, 172, 190, 198), fill="#ffffff")
    draw.text((42, 177), "RAVI KUMAR", fill="#182230", font=ImageFont.load_default())

    pasted_text = original.copy()
    draw = ImageDraw.Draw(pasted_text)
    draw.rectangle((270, 218, 430, 252), fill="#ffffff")
    draw.text((278, 224), "Rs 99,999", fill="#c1121f", font=ImageFont.load_default())

    jpeg_source = _encode(original, "JPEG", quality=90)
    jpeg = Image.open(io.BytesIO(jpeg_source)).convert("RGB")
    recompressed = Image.open(io.BytesIO(_encode(jpeg, "JPEG", quality=35))).convert("RGB")

    resized = original.resize((384, 512), Image.Resampling.BILINEAR)
    cropped = resized.crop((8, 8, 376, 504))

    multiple = amount.copy()
    patch = _copy_move().crop((20, 150, 170, 310))
    multiple.paste(patch, (260, 360))

    return [
        Fixture("unedited_png", False, original),
        Fixture("edited_amount", True, amount),
        Fixture("replaced_name", True, name),
        Fixture("pasted_text", True, pasted_text),
        Fixture("copy_move", True, _copy_move()),
        Fixture("messaging_recompression", False, recompressed, "JPEG"),
        Fixture("resized_and_cropped", False, cropped),
        Fixture("multiple_edits", True, multiple, "JPEG"),
    ]


def run_benchmark() -> dict[str, object]:
    outcomes = []
    true_positive = false_positive = true_negative = false_negative = 0
    corroborated_tp = corroborated_fp = corroborated_tn = corroborated_fn = 0
    for fixture in fixtures():
        file_name = f"{fixture.name}.{ 'jpg' if fixture.format_name == 'JPEG' else 'png' }"
        result = analyze_screenshot(_encode(fixture.image, fixture.format_name), file_name)
        detected = bool(result["suspiciousRegions"])
        corroborated = result["assessmentStatus"] == "potential_manipulation"
        if fixture.expected_edit and detected:
            true_positive += 1
        elif fixture.expected_edit:
            false_negative += 1
        elif detected:
            false_positive += 1
        else:
            true_negative += 1
        if fixture.expected_edit and corroborated:
            corroborated_tp += 1
        elif fixture.expected_edit:
            corroborated_fn += 1
        elif corroborated:
            corroborated_fp += 1
        else:
            corroborated_tn += 1
        outcomes.append({
            "fixture": fixture.name,
            "expected_edit": fixture.expected_edit,
            "any_region_flagged": detected,
            "corroborated_assessment": corroborated,
            "assessment": result["assessmentStatus"],
            "region_count": len(result["suspiciousRegions"]),
            "modules": {
                module_id: {
                    "status": finding["status"],
                    "metrics": finding["metrics"],
                }
                for module_id, finding in result["moduleFindings"].items()
            },
        })

    precision = true_positive / (true_positive + false_positive) if true_positive + false_positive else None
    recall = true_positive / (true_positive + false_negative) if true_positive + false_negative else None
    false_positive_rate = false_positive / (false_positive + true_negative) if false_positive + true_negative else None
    false_negative_rate = false_negative / (false_negative + true_positive) if false_negative + true_positive else None
    corroborated_precision = corroborated_tp / (corroborated_tp + corroborated_fp) if corroborated_tp + corroborated_fp else None
    corroborated_recall = corroborated_tp / (corroborated_tp + corroborated_fn) if corroborated_tp + corroborated_fn else None
    corroborated_fpr = corroborated_fp / (corroborated_fp + corroborated_tn) if corroborated_fp + corroborated_tn else None
    corroborated_fnr = corroborated_fn / (corroborated_fn + corroborated_tp) if corroborated_fn + corroborated_tp else None
    return {
        "scope": "Eight generated fixtures only; not representative of genuine app screenshots or real-world performance.",
        "detector": "Localized-region presence, not the combined assessment label, is treated as a positive.",
        "counts": {
            "true_positive": true_positive,
            "false_positive": false_positive,
            "true_negative": true_negative,
            "false_negative": false_negative,
        },
        "metrics": {
            "any_region_flagged": {
                "precision": precision,
                "recall": recall,
                "false_positive_rate": false_positive_rate,
                "false_negative_rate": false_negative_rate,
            },
            "corroborated_assessment": {
                "precision": corroborated_precision,
                "recall": corroborated_recall,
                "false_positive_rate": corroborated_fpr,
                "false_negative_rate": corroborated_fnr,
            },
        },
        "fixtures": outcomes,
    }


if __name__ == "__main__":
    print(json.dumps(run_benchmark(), indent=2))
