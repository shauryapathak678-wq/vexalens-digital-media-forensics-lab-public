"""OpenCV-based, measurement-first screenshot analysis.

The measurements are triage signals, not calibrated probabilities or proof of
manipulation. Thresholds are recorded with every analysis and are not presented
as accuracy claims.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import shutil
import subprocess
import time
import uuid
from dataclasses import dataclass
from typing import Any

import cv2
import numpy as np
from PIL import ExifTags, Image, UnidentifiedImageError

ENGINE_VERSION = "2.0.0-opencv"
MAX_IMAGE_BYTES = 25 * 1024 * 1024
MAX_IMAGE_PIXELS = 12_000_000
TILE_SIZE = 32

MODULE_LABELS = {
    "compressionEla": "JPEG Error Level Analysis",
    "copyMove": "SIFT Copy-Move Matching",
    "noiseAnalysis": "Local Noise Residuals",
    "resampling": "Resampling Periodicity",
    "imageBoundary": "Boundary / Compression Grid",
    "textAndFont": "Text Appearance Consistency",
    "ocrLayout": "OCR Text and Layout",
}

MODULE_LIMITATIONS = {
    "compressionEla": (
        "ELA only compares a JPEG with a new JPEG encode. It is not meaningful "
        "for PNG/WEBP originals and can flag ordinary high-contrast UI edges or "
        "multiple-save histories."
    ),
    "copyMove": (
        "Repeated icons, letters, patterns, and interface components can match "
        "legitimately. SIFT may miss flat, tiny, blurred, or heavily recompressed copies."
    ),
    "noiseAnalysis": (
        "Text, icons, gradients, antialiasing, denoising, scaling, and platform "
        "compression all change high-frequency residuals."
    ),
    "resampling": (
        "Display scaling, screenshot capture, browser rendering, and routine "
        "image resizing can produce periodic interpolation traces."
    ),
    "imageBoundary": (
        "Tile-to-tile residual changes can be caused by borders, text, icons, "
        "gradients, and compression. Global JPEG grid phase is affected by cropping."
    ),
    "textAndFont": (
        "OCR boxes and edge measurements vary with language, font, antialiasing, "
        "accessibility scaling, and image quality. Font differences alone are not proof."
    ),
    "ocrLayout": (
        "OCR is unavailable unless a local Tesseract executable is installed and "
        "configured. OCR omissions and recognition errors are possible."
    ),
}


@dataclass
class RegionSignal:
    box: tuple[int, int, int, int]
    module_id: str
    observation: str
    measurement: dict[str, float | int | str]


def _data_url(image: np.ndarray, extension: str = ".jpg") -> str:
    params = [cv2.IMWRITE_JPEG_QUALITY, 88] if extension == ".jpg" else []
    success, encoded = cv2.imencode(extension, image, params)
    if not success:
        raise ValueError(f"OpenCV could not encode the {extension} analysis image.")
    content_type = "image/jpeg" if extension == ".jpg" else "image/png"
    return f"data:{content_type};base64,{base64.b64encode(encoded.tobytes()).decode('ascii')}"


def _mask_data_url(
    mask: np.ndarray | None,
    boxes: list[tuple[int, int, int, int]],
    width: int,
    height: int,
    color_bgr: tuple[int, int, int],
) -> str:
    overlay = np.zeros((height, width, 4), dtype=np.uint8)
    if mask is not None and np.any(mask):
        overlay[mask > 0] = (color_bgr[2], color_bgr[1], color_bgr[0], 105)
    for x, y, box_width, box_height in boxes:
        cv2.rectangle(
            overlay,
            (x, y),
            (x + box_width, y + box_height),
            (color_bgr[2], color_bgr[1], color_bgr[0], 190),
            max(1, width // 600),
        )
    success, encoded = cv2.imencode(".png", overlay)
    if not success:
        raise ValueError("OpenCV could not encode a forensic region overlay.")
    return f"data:image/png;base64,{base64.b64encode(encoded.tobytes()).decode('ascii')}"


def _robust_threshold(values: np.ndarray, sensitivity: float) -> tuple[float, float, float]:
    finite = values[np.isfinite(values)]
    if finite.size == 0:
        return 0.0, 0.0, 0.0
    median = float(np.median(finite))
    mad = float(np.median(np.abs(finite - median)))
    robust_sigma = 1.4826 * mad
    threshold = median + sensitivity * robust_sigma
    return median, mad, threshold


def _tile_values(image: np.ndarray, tile_size: int = TILE_SIZE) -> tuple[np.ndarray, list[tuple[int, int, int, int]]]:
    height, width = image.shape[:2]
    boxes: list[tuple[int, int, int, int]] = []
    values: list[float] = []
    for y in range(0, height, tile_size):
        for x in range(0, width, tile_size):
            x2 = min(width, x + tile_size)
            y2 = min(height, y + tile_size)
            boxes.append((x, y, x2 - x, y2 - y))
            values.append(float(np.median(image[y:y2, x:x2])))
    columns = (width + tile_size - 1) // tile_size
    rows = (height + tile_size - 1) // tile_size
    return np.asarray(values, dtype=np.float32).reshape(rows, columns), boxes


def _mask_regions(
    tile_mask: np.ndarray,
    width: int,
    height: int,
    module_id: str,
    observation: str,
    measurements: np.ndarray,
) -> list[RegionSignal]:
    full_mask = np.kron(tile_mask.astype(np.uint8), np.ones((TILE_SIZE, TILE_SIZE), dtype=np.uint8))
    full_mask = full_mask[:height, :width]
    count, labels, stats, _ = cv2.connectedComponentsWithStats(full_mask, connectivity=8)
    regions: list[RegionSignal] = []
    for label in range(1, count):
        x, y, box_width, box_height, area = (int(value) for value in stats[label])
        if area < max(64, int(width * height * 0.00008)):
            continue
        tile_x1 = x // TILE_SIZE
        tile_y1 = y // TILE_SIZE
        tile_x2 = min(tile_mask.shape[1], (x + box_width - 1) // TILE_SIZE + 1)
        tile_y2 = min(tile_mask.shape[0], (y + box_height - 1) // TILE_SIZE + 1)
        local_values = measurements[tile_y1:tile_y2, tile_x1:tile_x2]
        regions.append(RegionSignal(
            (x, y, box_width, box_height),
            module_id,
            observation,
            {
                "connected_pixel_area": area,
                "local_median_measurement": round(float(np.median(local_values)), 4) if local_values.size else 0.0,
            },
        ))
    return regions


def _iou(first: tuple[int, int, int, int], second: tuple[int, int, int, int]) -> float:
    ax, ay, aw, ah = first
    bx, by, bw, bh = second
    left = max(ax, bx)
    top = max(ay, by)
    right = min(ax + aw, bx + bw)
    bottom = min(ay + ah, by + bh)
    intersection = max(0, right - left) * max(0, bottom - top)
    union = aw * ah + bw * bh - intersection
    return intersection / union if union else 0.0


def _merge_regions(signals: list[RegionSignal], region_width: int, region_height: int) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    for signal in sorted(signals, key=lambda item: item.box[2] * item.box[3], reverse=True):
        target = next((region for region in merged if _iou(region["pixelBox"], signal.box) >= 0.15), None)
        if target is None:
            target = {
                "pixelBox": signal.box,
                "modules": [],
                "observations": [],
                "measurements": {},
            }
            merged.append(target)
        else:
            x1, y1, width1, height1 = target["pixelBox"]
            x2, y2, width2, height2 = signal.box
            left = min(x1, x2)
            top = min(y1, y2)
            right = max(x1 + width1, x2 + width2)
            bottom = max(y1 + height1, y2 + height2)
            target["pixelBox"] = (left, top, right - left, bottom - top)
        if signal.module_id not in target["modules"]:
            target["modules"].append(signal.module_id)
        target["observations"].append(signal.observation)
        target["measurements"][signal.module_id] = signal.measurement

    output: list[dict[str, Any]] = []
    for index, region in enumerate(merged, start=1):
        x, y, width, height = region["pixelBox"]
        output.append({
            "id": f"region-{index}",
            "regionNumber": index,
            "box": {
                "x": round(x / max(1, region_width), 6),
                "y": round(y / max(1, region_height), 6),
                "width": round(width / max(1, region_width), 6),
                "height": round(height / max(1, region_height), 6),
            },
            "pixelBox": {"x": x, "y": y, "width": width, "height": height},
            "label": f"Area {index}: {', '.join(MODULE_LABELS[module] for module in region['modules'])}",
            "technique": ", ".join(MODULE_LABELS[module] for module in region["modules"]),
            "modules": region["modules"],
            "evidenceFamilies": sorted(_evidence_families(region["modules"])),
            "signalLevel": "corroborated" if len(_evidence_families(region["modules"])) >= 2 else "single-test",
            "simpleObservation": "Multiple local signals" if len(_evidence_families(region["modules"])) >= 2 else "Local difference",
            "easyWords": (
                "More than one independent check found a difference in this area. "
                "This needs review; normal compression or interface graphics can also cause signals."
                if len(_evidence_families(region["modules"])) >= 2
                else "One check found a local difference. This alone cannot tell whether the image was edited."
            ),
            "reason": "; ".join(dict.fromkeys(region["observations"])),
            "technicalObservations": json.dumps(region["measurements"], sort_keys=True),
            "limitations": "See the contributing module limitations; measurements are not calibrated probabilities.",
            "measurements": region["measurements"],
        })
    return output


def _evidence_families(module_ids: list[str]) -> set[str]:
    families = {
        "compressionEla": "compression",
        "copyMove": "feature_geometry",
        "noiseAnalysis": "pixel_residual",
        "imageBoundary": "pixel_residual",
        "textAndFont": "ocr_geometry",
        "ocrLayout": "ocr_geometry",
        "resampling": "global_periodicity",
    }
    return {families[module_id] for module_id in module_ids if module_id in families}


def _run_ocr(image: np.ndarray) -> tuple[list[dict[str, Any]], str | None]:
    executable = (
        os.environ.get("TESSERACT_PATH", "").strip()
        or os.environ.get("TESSERACT_CMD", "").strip()
        or shutil.which("tesseract")
    )
    if not executable:
        return [], None
    success, encoded = cv2.imencode(".png", image)
    if not success:
        return [], "Could not encode the image for local OCR."
    try:
        process = subprocess.run(
            [executable, "stdin", "stdout", "tsv", "--psm", "11"],
            input=encoded.tobytes(),
            capture_output=True,
            check=False,
            timeout=30,
        )
    except subprocess.TimeoutExpired:
        return [], "Local Tesseract OCR exceeded its 30-second limit."
    except OSError as error:
        return [], f"Local Tesseract OCR could not start: {error}"
    if process.returncode != 0:
        return [], f"Local Tesseract OCR failed with exit code {process.returncode}."
    lines = process.stdout.decode("utf-8", errors="replace").splitlines()
    if not lines:
        return [], "Tesseract returned no TSV output."
    words: list[dict[str, Any]] = []
    for line in lines[1:]:
        fields = line.split("\t", 11)
        if len(fields) != 12 or not fields[11].strip():
            continue
        try:
            confidence = float(fields[10])
            if confidence < 0:
                continue
            words.append({
                "text": fields[11].strip(),
                "box": {
                    "x": int(fields[6]),
                    "y": int(fields[7]),
                    "width": int(fields[8]),
                    "height": int(fields[9]),
                },
                "ocrConfidence": round(confidence, 2),
                "line": f"{fields[1]}-{fields[2]}-{fields[3]}-{fields[4]}",
            })
        except (ValueError, IndexError):
            continue
    return words, None


def analyze_screenshot(
    image_bytes: bytes,
    file_name: str = "screenshot.png",
    category: str = "other",
    sensitivity: float = 3.0,
) -> dict[str, Any]:
    started = time.perf_counter()
    if not image_bytes:
        raise ValueError("The uploaded image is empty.")
    if len(image_bytes) > MAX_IMAGE_BYTES:
        raise ValueError("Image exceeds the 25 MB upload limit.")
    if not 1.0 <= float(sensitivity) <= 5.0:
        raise ValueError("Sensitivity must be between 1 and 5.")

    try:
        pil_image = Image.open(io.BytesIO(image_bytes))
        original_format = (pil_image.format or "").upper()
        width, height = pil_image.size
        if width <= 0 or height <= 0 or width * height > MAX_IMAGE_PIXELS:
            raise ValueError("Image exceeds the 12-megapixel analysis limit.")
        exif = pil_image.getexif()
        exif_tags = {
            ExifTags.TAGS.get(tag, str(tag)): str(value)[:500]
            for tag, value in exif.items()
            if tag in ExifTags.TAGS
        }
    except (UnidentifiedImageError, OSError) as error:
        raise ValueError("The upload is not a valid, readable image.") from error

    if original_format not in {"JPEG", "PNG", "WEBP"}:
        raise ValueError("Supported image formats are JPEG, PNG, and WEBP.")
    image_array = np.frombuffer(image_bytes, dtype=np.uint8)
    bgr = cv2.imdecode(image_array, cv2.IMREAD_COLOR)
    if bgr is None or bgr.size == 0:
        raise ValueError("OpenCV could not decode this image.")
    height, width = bgr.shape[:2]
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    image_sha256 = hashlib.sha256(image_bytes).hexdigest()
    image_md5 = hashlib.md5(image_bytes, usedforsecurity=False).hexdigest()
    sensitivity_value = float(sensitivity)

    module_results: dict[str, dict[str, Any]] = {}
    signals: list[RegionSignal] = []
    module_masks: dict[str, np.ndarray] = {}

    # ELA is deliberately not run on lossless PNG or WEBP originals.
    if original_format == "JPEG":
        success, recompressed = cv2.imencode(".jpg", bgr, [cv2.IMWRITE_JPEG_QUALITY, 75])
        if not success:
            raise ValueError("Could not create a JPEG recompression for ELA.")
        recompressed_bgr = cv2.imdecode(recompressed, cv2.IMREAD_COLOR)
        ela = cv2.absdiff(bgr, recompressed_bgr)
        ela_gray = cv2.cvtColor(ela, cv2.COLOR_BGR2GRAY)
        ela_tiles, _ = _tile_values(ela_gray)
        median, mad, _ = _robust_threshold(ela_tiles, 1.0)
        threshold = median + (sensitivity_value + 1.0) * 1.4826 * mad
        threshold = max(threshold, median + 2.0)
        ela_tile_mask = ela_tiles > threshold
        module_masks["compressionEla"] = np.kron(
            ela_tile_mask.astype(np.uint8), np.ones((TILE_SIZE, TILE_SIZE), dtype=np.uint8)
        )[:height, :width]
        if np.any(ela_tile_mask):
            signals.extend(_mask_regions(
                ela_tile_mask, width, height, "compressionEla",
                "This JPEG tile has a higher-than-image-baseline recompression difference.",
                ela_tiles,
            ))
        p99 = float(np.percentile(ela_gray, 99)) if ela_gray.size else 0.0
        ela_display = np.clip(ela_gray.astype(np.float32) * (220.0 / max(1.0, p99)), 0, 255).astype(np.uint8)
        module_results["compressionEla"] = {
            "id": "compressionEla", "name": MODULE_LABELS["compressionEla"],
            "status": "flagged" if any(signal.module_id == "compressionEla" for signal in signals) else "clean",
            "simpleObservation": "JPEG differences flagged" if np.any(ela_tile_mask) else "No localized ELA outlier",
            "whatWasChecked": "Absolute pixel difference between original JPEG pixels and a fresh JPEG encode at quality 75; compared per 32x32 tile.",
            "whatWasFound": (
                f"JPEG ELA tile median {median:.3f}; median absolute deviation {mad:.3f}; flagged {int(ela_tile_mask.sum())} tiles."
            ),
            "whyItMatters": "Localized differences can identify areas with a different recompression response, but that response has many benign causes.",
            "reliability": "Exploratory JPEG-only measurement; not a calibrated detector.",
            "limitations": MODULE_LIMITATIONS["compressionEla"],
            "thresholds": {
                "jpeg_quality": 75,
                "tile_pixels": TILE_SIZE,
                "tile_median_threshold": round(threshold, 4),
                "robust_mad_multiplier": round(sensitivity_value + 1.0, 2),
                "sensitivity_1_to_5": sensitivity_value,
            },
            "metrics": {"tile_median_baseline": round(median, 4), "tile_mad": round(mad, 4), "tile_flag_count": int(ela_tile_mask.sum()), "tile_count": int(ela_tiles.size), "pixel_difference_mean": round(float(np.mean(ela_gray)), 4), "pixel_difference_p99": round(p99, 4)},
            "affectedRegionIds": [],
            "_visual": ela_display,
        }
    else:
        module_results["compressionEla"] = {
            "id": "compressionEla", "name": MODULE_LABELS["compressionEla"],
            "status": "not_applicable", "simpleObservation": "Not applicable",
            "whatWasChecked": "ELA eligibility based on the original image container format.",
            "whatWasFound": f"Original format is {original_format}; JPEG recompression differences are not measured for this source.",
            "whyItMatters": "A lossless PNG or WEBP screenshot has no original JPEG recompression history to compare.",
            "reliability": "Not run.",
            "limitations": MODULE_LIMITATIONS["compressionEla"],
            "thresholds": {"required_original_format": "JPEG"},
            "metrics": {"original_format": original_format},
            "affectedRegionIds": [],
        }

    # SIFT feature matching with a displacement-cluster requirement.
    sift = cv2.SIFT_create(nfeatures=3500, contrastThreshold=0.04, edgeThreshold=12)
    keypoints, descriptors = sift.detectAndCompute(gray, None)
    copy_regions: list[RegionSignal] = []
    displacement_clusters = 0
    matched_good = 0
    if descriptors is not None and len(keypoints) >= 12:
        matcher = cv2.BFMatcher(cv2.NORM_L2)
        pairs = matcher.knnMatch(descriptors, descriptors, k=3)
        displacements: dict[tuple[int, int], list[Any]] = {}
        for pair in pairs:
            non_self = [match for match in pair if match.trainIdx != match.queryIdx]
            if len(non_self) < 2:
                continue
            first, second = non_self[:2]
            if first.distance >= 0.72 * second.distance:
                continue
            source = np.asarray(keypoints[first.queryIdx].pt)
            target = np.asarray(keypoints[first.trainIdx].pt)
            delta = target - source
            if float(np.linalg.norm(delta)) < max(24.0, min(width, height) * 0.04):
                continue
            key = (int(round(delta[0] / 8.0)), int(round(delta[1] / 8.0)))
            displacements.setdefault(key, []).append((source, target, first.distance))
        candidates = sorted(displacements.values(), key=len, reverse=True)
        for matches in candidates[:4]:
            if len(matches) < 10:
                continue
            source_points = np.asarray([match[0] for match in matches])
            target_points = np.asarray([match[1] for match in matches])
            if np.ptp(source_points[:, 0]) < 12 or np.ptp(source_points[:, 1]) < 12:
                continue
            if np.ptp(target_points[:, 0]) < 12 or np.ptp(target_points[:, 1]) < 12:
                continue
            displacement_clusters += 1
            matched_good += len(matches)
            for points in (source_points, target_points):
                x1, y1 = np.floor(points.min(axis=0) - 12).astype(int)
                x2, y2 = np.ceil(points.max(axis=0) + 12).astype(int)
                x1, y1 = max(0, x1), max(0, y1)
                x2, y2 = min(width, x2), min(height, y2)
                if x2 > x1 and y2 > y1:
                    copy_regions.append(RegionSignal(
                        (int(x1), int(y1), int(x2 - x1), int(y2 - y1)),
                        "copyMove",
                        "SIFT descriptors matched across a consistent non-local displacement cluster.",
                        {"displacement_cluster_matches": len(matches)},
                    ))
    module_results["copyMove"] = {
        "id": "copyMove", "name": MODULE_LABELS["copyMove"],
        "status": "flagged" if displacement_clusters else "clean",
        "simpleObservation": "Repeated-feature match" if displacement_clusters else "No displacement cluster",
        "whatWasChecked": "SIFT keypoint descriptors, Lowe ratio test (0.72), and clusters of spatial displacement separated by at least 4% of the shorter image dimension.",
        "whatWasFound": f"{len(keypoints)} SIFT keypoints, {matched_good} matches in {displacement_clusters} qualifying displacement cluster(s).",
        "whyItMatters": "A copied patch can preserve local keypoint descriptors at a consistent offset.",
        "reliability": "Exploratory feature matching; repeated interface icons can produce legitimate matches.",
        "limitations": MODULE_LIMITATIONS["copyMove"],
        "thresholds": {"ratio_test": 0.72, "minimum_matches_per_cluster": 10, "minimum_patch_span_pixels": 12},
        "metrics": {"keypoint_count": len(keypoints), "qualifying_matches": matched_good, "displacement_clusters": displacement_clusters},
        "affectedRegionIds": [],
    }
    signals.extend(copy_regions)

    # High-pass residual noise, robust per-tile outliers, and boundary discontinuities.
    gray_float = gray.astype(np.float32)
    blur = cv2.GaussianBlur(gray_float, (3, 3), 0)
    residual = cv2.absdiff(gray_float, blur)
    noise_tiles, _ = _tile_values(residual)
    noise_median, noise_mad, _ = _robust_threshold(noise_tiles, 1.0)
    noise_threshold = max(noise_median + (sensitivity_value + 1.0) * 1.4826 * noise_mad, noise_median + 1.0)
    noise_mask = noise_tiles > noise_threshold
    module_masks["noiseAnalysis"] = np.kron(
        noise_mask.astype(np.uint8), np.ones((TILE_SIZE, TILE_SIZE), dtype=np.uint8)
    )[:height, :width]
    if np.any(noise_mask):
        signals.extend(_mask_regions(
            noise_mask, width, height, "noiseAnalysis",
            "This tile has a higher local high-pass residual than the robust image-wide baseline.",
            noise_tiles,
        ))
    module_results["noiseAnalysis"] = {
        "id": "noiseAnalysis", "name": MODULE_LABELS["noiseAnalysis"],
        "status": "flagged" if any(signal.module_id == "noiseAnalysis" for signal in signals) else "clean",
        "simpleObservation": "Residual outliers" if np.any(noise_mask) else "No residual outliers",
        "whatWasChecked": "Median absolute difference from a 3x3 Gaussian-smoothed grayscale image, summarized in 32x32 tiles.",
        "whatWasFound": f"Residual tile median {noise_median:.4f}; MAD {noise_mad:.4f}; {int(noise_mask.sum())} tile(s) exceed threshold {noise_threshold:.4f}.",
        "whyItMatters": "A sudden local change in high-frequency residuals can be a boundary cue, but interface text and icons naturally create these changes.",
        "reliability": "Exploratory local measurement; benign structure is a major confounder.",
        "limitations": MODULE_LIMITATIONS["noiseAnalysis"],
        "thresholds": {"tile_pixels": TILE_SIZE, "robust_mad_multiplier": round(sensitivity_value + 1.0, 2), "tile_median_threshold": round(noise_threshold, 4)},
        "metrics": {"tile_median_baseline": round(noise_median, 4), "tile_mad": round(noise_mad, 4), "tile_flag_count": int(noise_mask.sum()), "tile_count": int(noise_tiles.size)},
        "affectedRegionIds": [],
    }

    # A local discontinuity in residual noise can suggest a boundary, but is
    # grouped with the residual module for corroboration because it reuses data.
    neighbor_differences: list[np.ndarray] = []
    boundary_tile_mask = np.zeros_like(noise_tiles, dtype=bool)
    if noise_tiles.shape[1] > 1:
        horizontal = np.abs(np.diff(noise_tiles, axis=1))
        neighbor_differences.append(horizontal.ravel())
        rows, columns = np.where(horizontal > 0)
        boundary_tile_mask[rows, columns] = True
        boundary_tile_mask[rows, columns + 1] = True
    if noise_tiles.shape[0] > 1:
        vertical = np.abs(np.diff(noise_tiles, axis=0))
        neighbor_differences.append(vertical.ravel())
        rows, columns = np.where(vertical > 0)
        boundary_tile_mask[rows, columns] = True
        boundary_tile_mask[rows + 1, columns] = True
    differences = np.concatenate(neighbor_differences) if neighbor_differences else np.asarray([], dtype=np.float32)
    difference_median, difference_mad, _ = _robust_threshold(differences, 1.0)
    boundary_threshold = max(
        difference_median + (sensitivity_value + 1.0) * 1.4826 * difference_mad,
        difference_median + 0.5,
    )
    boundary_tile_mask = np.zeros_like(noise_tiles, dtype=bool)
    if noise_tiles.shape[1] > 1:
        rows, columns = np.where(np.abs(np.diff(noise_tiles, axis=1)) > boundary_threshold)
        boundary_tile_mask[rows, columns] = True
        boundary_tile_mask[rows, columns + 1] = True
    if noise_tiles.shape[0] > 1:
        rows, columns = np.where(np.abs(np.diff(noise_tiles, axis=0)) > boundary_threshold)
        boundary_tile_mask[rows, columns] = True
        boundary_tile_mask[rows + 1, columns] = True
    module_masks["imageBoundary"] = np.kron(
        boundary_tile_mask.astype(np.uint8), np.ones((TILE_SIZE, TILE_SIZE), dtype=np.uint8)
    )[:height, :width]
    boundary_signals = _mask_regions(
        boundary_tile_mask, width, height, "imageBoundary",
        "Adjacent tiles have a larger-than-baseline change in median high-pass residual.",
        noise_tiles,
    ) if np.any(boundary_tile_mask) else []
    signals.extend(boundary_signals)
    grid_ratio: float | None = None
    if original_format == "JPEG":
        grad_x = np.abs(np.diff(gray.astype(np.float32), axis=1))
        boundary_values = grad_x[:, 7::8]
        non_boundary_values = grad_x[:, 3::8]
        boundary_mean = float(np.mean(boundary_values)) if boundary_values.size else 0.0
        non_boundary_mean = float(np.mean(non_boundary_values)) if non_boundary_values.size else 0.0
        grid_ratio = boundary_mean / max(non_boundary_mean, 1e-6)
    module_results["imageBoundary"] = {
        "id": "imageBoundary", "name": MODULE_LABELS["imageBoundary"],
        "status": "flagged" if boundary_signals else "clean",
        "simpleObservation": "Residual boundary changes" if boundary_signals else "No residual boundary outliers",
        "whatWasChecked": (
            "Adjacent 32x32 tile medians of the 3x3 high-pass residual; JPEG block-boundary gradient ratio is also measured for JPEG inputs."
        ),
        "whatWasFound": (
            f"{int(boundary_tile_mask.sum())} tile(s) border a residual discontinuity; adjacent-difference median "
            f"{difference_median:.4f}, MAD {difference_mad:.4f}, threshold {boundary_threshold:.4f}."
            + (f" JPEG grid ratio {grid_ratio:.4f}." if grid_ratio is not None else " JPEG grid measurement is not applicable.")
        ),
        "whyItMatters": "A localized change in noise texture at a boundary can guide a splice review but is not specific to compositing.",
        "reliability": "Exploratory residual discontinuity; correlated with the local-noise module and not counted as independent corroboration.",
        "limitations": MODULE_LIMITATIONS["imageBoundary"],
        "thresholds": {
            "tile_pixels": TILE_SIZE,
            "adjacent_difference_threshold": round(boundary_threshold, 4),
            "robust_mad_multiplier": round(sensitivity_value + 1.0, 2),
            "sensitivity_1_to_5": sensitivity_value,
            "jpeg_grid_period_pixels": 8 if grid_ratio is not None else "not_applicable",
        },
        "metrics": {
            "tile_count": int(noise_tiles.size),
            "boundary_tile_count": int(boundary_tile_mask.sum()),
            "adjacent_difference_median": round(difference_median, 4),
            "adjacent_difference_mad": round(difference_mad, 4),
            "jpeg_grid_ratio": round(grid_ratio, 5) if grid_ratio is not None else "not_applicable",
        },
        "affectedRegionIds": [],
    }

    # Interpolation/resampling observations are global measurements; they do not
    # create local highlight boxes without spatially localized evidence.
    second_x = cv2.Sobel(gray, cv2.CV_32F, 2, 0, ksize=3)
    second_y = cv2.Sobel(gray, cv2.CV_32F, 0, 2, ksize=3)
    periodicity_metrics: dict[str, float] = {}
    for axis, values in (("x", second_x), ("y", second_y)):
        profile = np.mean(np.abs(values), axis=0 if axis == "x" else 1)
        centered = profile - float(np.mean(profile))
        if centered.size > 16 and float(np.std(centered)) > 1e-6:
            energy = max(float(np.dot(centered, centered)), 1e-9)
            periodicity_metrics[f"{axis}_lag2_autocorrelation"] = round(
                float(np.dot(centered[:-2], centered[2:]) / energy), 5
            )
            periodicity_metrics[f"{axis}_lag4_autocorrelation"] = round(
                float(np.dot(centered[:-4], centered[4:]) / energy), 5
            )
        else:
            periodicity_metrics[f"{axis}_lag2_autocorrelation"] = 0.0
            periodicity_metrics[f"{axis}_lag4_autocorrelation"] = 0.0
    module_results["resampling"] = {
        "id": "resampling", "name": MODULE_LABELS["resampling"],
        "status": "inconclusive",
        "simpleObservation": "Measured; not independently diagnostic",
        "whatWasChecked": "Normalized lag-2 and lag-4 autocorrelation of absolute second-derivative image profiles.",
        "whatWasFound": "Periodic profile measurements are reported as descriptive values; no isolated resampling region is inferred from this global statistic.",
        "whyItMatters": "Interpolation can leave periodic edge traces, but scaling and rendering can create similar patterns.",
        "reliability": "Research cue only; no calibrated classifier is applied.",
        "limitations": MODULE_LIMITATIONS["resampling"],
        "thresholds": {"classification_threshold": "not established; measurements are descriptive"},
        "metrics": periodicity_metrics,
        "affectedRegionIds": [],
    }

    # OCR is local and optional. Do not substitute fabricated text if unavailable.
    ocr_words, ocr_error = _run_ocr(bgr)
    ocr_available = bool(
        os.environ.get("TESSERACT_PATH", "").strip()
        or os.environ.get("TESSERACT_CMD", "").strip()
        or shutil.which("tesseract")
    )
    text_regions: list[RegionSignal] = []
    layout_regions: list[RegionSignal] = []
    line_groups: dict[str, list[dict[str, Any]]] = {}
    for word in ocr_words:
        line_groups.setdefault(word["line"], []).append(word)
    font_outliers = 0
    layout_outliers = 0
    edge_density_values: list[float] = []
    sharpness_values: list[float] = []
    for word in ocr_words:
        x = max(0, word["box"]["x"])
        y = max(0, word["box"]["y"])
        x2 = min(width, x + word["box"]["width"])
        y2 = min(height, y + word["box"]["height"])
        word_crop = gray[y:y2, x:x2]
        if word_crop.size:
            edges = cv2.Canny(word_crop, 50, 150)
            edge_density = float(np.count_nonzero(edges) / edges.size)
            sharpness = float(cv2.Laplacian(word_crop, cv2.CV_32F).var())
        else:
            edge_density = 0.0
            sharpness = 0.0
        word["appearanceMeasurements"] = {
            "edge_density": round(edge_density, 5),
            "laplacian_variance": round(sharpness, 4),
        }
        edge_density_values.append(edge_density)
        sharpness_values.append(sharpness)
    for words in line_groups.values():
        if len(words) < 4:
            continue
        heights = np.asarray([word["box"]["height"] for word in words], dtype=np.float32)
        median_height = float(np.median(heights))
        mad_height = float(np.median(np.abs(heights - median_height)))
        threshold_height = max(2.0, 3.0 * 1.4826 * mad_height)
        sorted_words = sorted(words, key=lambda word: word["box"]["x"])
        gaps = np.asarray([
            following["box"]["x"] - (current["box"]["x"] + current["box"]["width"])
            for current, following in zip(sorted_words, sorted_words[1:])
        ], dtype=np.float32)
        if gaps.size:
            median_gap = float(np.median(gaps))
            mad_gap = float(np.median(np.abs(gaps - median_gap)))
            gap_threshold = max(4.0, median_gap + 3.0 * 1.4826 * mad_gap)
            for gap_index, gap in enumerate(gaps):
                if gap > gap_threshold:
                    word = sorted_words[gap_index + 1]
                    layout_outliers += 1
                    layout_regions.append(RegionSignal(
                        (
                            word["box"]["x"], word["box"]["y"],
                            word["box"]["width"], word["box"]["height"],
                        ),
                        "ocrLayout",
                        "OCR word spacing differs from the robust same-line gap baseline; legitimate layout variation is possible.",
                        {
                            "word_gap_pixels": round(float(gap), 3),
                            "same_line_median_gap_pixels": round(median_gap, 3),
                            "gap_threshold_pixels": round(gap_threshold, 3),
                        },
                    ))
        baselines = np.asarray(
            [word["box"]["y"] + word["box"]["height"] for word in words],
            dtype=np.float32,
        )
        median_baseline = float(np.median(baselines))
        mad_baseline = float(np.median(np.abs(baselines - median_baseline)))
        baseline_threshold = max(2.0, 3.0 * 1.4826 * mad_baseline)
        for word, baseline in zip(words, baselines):
            if abs(float(baseline) - median_baseline) > baseline_threshold:
                layout_outliers += 1
                layout_regions.append(RegionSignal(
                    (
                        word["box"]["x"], word["box"]["y"],
                        word["box"]["width"], word["box"]["height"],
                    ),
                    "ocrLayout",
                    "OCR word baseline differs from the robust same-line baseline; OCR boxes can vary with glyph shape.",
                    {
                        "word_baseline_pixels": int(baseline),
                        "same_line_median_baseline_pixels": round(median_baseline, 3),
                        "baseline_threshold_pixels": round(baseline_threshold, 3),
                    },
                ))
        for word in words:
            if abs(word["box"]["height"] - median_height) > threshold_height:
                font_outliers += 1
                x, y, box_width, box_height = (
                    word["box"]["x"], word["box"]["y"],
                    word["box"]["width"], word["box"]["height"],
                )
                text_regions.append(RegionSignal(
                    (x, y, box_width, box_height),
                    "textAndFont",
                    "OCR word height differs from the robust same-line median; appearance measurements and font size differences alone are not evidence of manipulation.",
                    {
                        "word_height_pixels": box_height,
                        "same_line_median_height_pixels": round(median_height, 3),
                        "ocr_recognition_confidence": word["ocrConfidence"],
                        **word["appearanceMeasurements"],
                    },
                ))
    signals.extend(text_regions)
    signals.extend(layout_regions)
    module_results["textAndFont"] = {
        "id": "textAndFont", "name": MODULE_LABELS["textAndFont"],
        "status": "not_applicable" if not ocr_available else (
            "inconclusive" if ocr_error else "flagged" if font_outliers else "clean"
        ),
        "simpleObservation": "OCR unavailable" if not ocr_available else ("Text geometry outliers" if font_outliers else "No text geometry outliers"),
        "whatWasChecked": "Tesseract TSV word boxes; within-line word-height outliers using median plus 3 scaled MAD (minimum 2 px).",
        "whatWasFound": (
            f"{font_outliers} word-height outlier(s) across {len(ocr_words)} OCR words."
            if ocr_available else "No OCR executable is configured; font and text consistency were not assessed."
        ),
        "whyItMatters": "Large word-box geometry differences can guide review but are not specific to editing.",
        "reliability": "Exploratory OCR geometry only; no font identity classifier is applied.",
        "limitations": MODULE_LIMITATIONS["textAndFont"] + (f" OCR note: {ocr_error}" if ocr_error else ""),
        "thresholds": {"minimum_words_per_line": 4, "height_outlier_mad_multiplier": 3.0, "minimum_height_deviation_pixels": 2},
        "metrics": {
            "ocr_word_count": len(ocr_words),
            "ocr_line_count": len(line_groups),
            "word_height_outliers": font_outliers,
            "median_word_edge_density": round(float(np.median(edge_density_values)), 5) if edge_density_values else 0.0,
            "median_word_laplacian_variance": round(float(np.median(sharpness_values)), 4) if sharpness_values else 0.0,
        },
        "affectedRegionIds": [],
    }
    module_results["ocrLayout"] = {
        "id": "ocrLayout", "name": MODULE_LABELS["ocrLayout"],
        "status": "not_applicable" if not ocr_available else (
            "inconclusive" if ocr_error else "flagged" if layout_outliers else "clean"
        ),
        "simpleObservation": "OCR unavailable" if not ocr_available else ("OCR error" if ocr_error else "OCR completed"),
        "whatWasChecked": "Local Tesseract word boxes, same-line inter-word gaps, baseline positions, and OCR recognition confidence.",
        "whatWasFound": (
            ocr_error if ocr_error else
            f"Extracted {len(ocr_words)} word(s) from {len(line_groups)} text line(s); {layout_outliers} spacing/baseline outlier(s)." if ocr_available else
            "OCR was not run because no Tesseract executable is configured."
        ),
        "whyItMatters": "Extracted text and boxes can help compare a screenshot with the source transaction or app.",
        "reliability": "Text extraction support only; OCR recognition confidence is not manipulation confidence.",
        "limitations": MODULE_LIMITATIONS["ocrLayout"],
        "thresholds": {"minimum_words_per_line": 4, "gap_mad_multiplier": 3.0, "baseline_mad_multiplier": 3.0, "tesseract_page_segmentation_mode": 11, "timeout_seconds": 30},
        "metrics": {"ocr_word_count": len(ocr_words), "ocr_line_count": len(line_groups), "layout_outliers": layout_outliers, "ocr_available": int(ocr_available)},
        "affectedRegionIds": [],
    }
    regions = _merge_regions(signals, width, height)
    for region in regions:
        for module_id in region["modules"]:
            module_results[module_id]["affectedRegionIds"].append(region["id"])
        x, y, box_width, box_height = region["pixelBox"].values()
        crop = bgr[y:y + box_height, x:x + box_width]
        if crop.size:
            region["cropDataUrl"] = _data_url(crop)

    corroborated = any(len(_evidence_families(region["modules"])) >= 2 for region in regions)
    if corroborated:
        assessment_status = "potential_manipulation"
        assessment_summary = "Multiple local signals — manual review required"
        assessment_explanation = (
            "At least two independent checks identified overlapping pixel differences. "
            "This does not prove manipulation; native app graphics, repeated interface "
            "elements, resizing, and compression can also produce signals."
        )
    elif regions:
        assessment_status = "inconclusive"
        assessment_summary = "Inconclusive — one or more local signals"
        assessment_explanation = (
            "One or more checks flagged local differences, but there is not independent "
            "corroboration in the same area. These results cannot determine whether the "
            "image was edited. Compare it with the original source."
        )
    else:
        assessment_status = "no_indicators"
        assessment_summary = "No regions flagged by the implemented tests"
        assessment_explanation = (
            "The applicable tests did not flag a localized region. This is not proof "
            "that the image is genuine or unmodified."
        )

    overlay = bgr.copy()
    module_colors = {
        "compressionEla": (255, 0, 255),
        "copyMove": (0, 220, 255),
        "noiseAnalysis": (0, 0, 255),
        "imageBoundary": (0, 220, 0),
        "textAndFont": (255, 180, 0),
    }
    for module_id, mask in module_masks.items():
        if np.any(mask):
            color = np.zeros_like(overlay)
            color[mask > 0] = module_colors[module_id]
            overlay = cv2.addWeighted(overlay, 1.0, color, 0.35, 0)
    for signal in signals:
        if signal.module_id in module_masks:
            continue
        x, y, box_width, box_height = signal.box
        color = module_colors.get(signal.module_id, (0, 210, 255))
        cv2.rectangle(overlay, (x, y), (x + box_width, y + box_height), color, max(1, width // 600))
    module_overlay_data_urls: dict[str, str] = {}
    for module_id in dict.fromkeys(signal.module_id for signal in signals):
        module_boxes = [signal.box for signal in signals if signal.module_id == module_id]
        module_overlay_data_urls[module_id] = _mask_data_url(
            module_masks.get(module_id),
            module_boxes,
            width,
            height,
            module_colors.get(module_id, (0, 210, 255)),
        )
    annotated = bgr.copy()
    for region in regions:
        x, y, box_width, box_height = region["pixelBox"].values()
        cv2.rectangle(annotated, (x, y), (x + box_width, y + box_height), (0, 210, 255), max(1, width // 600))
        cv2.putText(annotated, f"R{region['regionNumber']}", (x, max(14, y - 4)), cv2.FONT_HERSHEY_SIMPLEX, max(0.35, width / 1800), (0, 210, 255), 1, cv2.LINE_AA)

    timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    return {
        "id": f"scan-{uuid.uuid4()}",
        "evidenceId": f"ev-{image_sha256[:12]}",
        "fileName": os.path.basename(file_name) or "screenshot",
        "fileSize": len(image_bytes),
        "fileType": {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp"}[original_format],
        "sha256": image_sha256,
        "md5": image_md5,
        "uploadTimestamp": timestamp,
        "analysisTimestamp": timestamp,
        "category": category,
        "assessmentStatus": assessment_status,
        "simpleVerdict": {
            "potential_manipulation": "Multiple local signals",
            "inconclusive": "Unclear — needs comparison",
            "no_indicators": "No regions flagged",
        }[assessment_status],
        "assessmentSummary": assessment_summary,
        "easyWordsSummary": assessment_explanation,
        "assessmentExplanation": assessment_explanation,
        "assessmentMethod": (
            "No numeric fraud score is calculated. Corroboration requires overlapping regions "
            "from two evidence families: JPEG compression, local feature geometry, pixel residuals, "
            "or OCR geometry. Related checks within one family count once; one family alone remains inconclusive."
        ),
        "suspiciousRegions": regions,
        "moduleFindings": module_results,
        "heatmapDataUrl": _data_url(overlay),
        "moduleOverlayDataUrls": module_overlay_data_urls,
        "annotatedDataUrl": _data_url(annotated),
        "imageDimensions": {"width": width, "height": height},
        "imageMetadata": {
            "format": original_format,
            "exifAvailable": bool(exif_tags),
            "exif": exif_tags,
        },
        "ocrText": ocr_words,
        "parameters": {
            "engine": ENGINE_VERSION,
            "opencv": cv2.__version__,
            "sensitivity": sensitivity_value,
            "tile_pixels": TILE_SIZE,
            "max_image_bytes": MAX_IMAGE_BYTES,
            "max_image_pixels": MAX_IMAGE_PIXELS,
            "tesseractConfigured": ocr_available,
        },
        "limitations": [
            "This exploratory system is not validated for determining authenticity, fraud, authorship, or intent.",
            "Screenshot rendering, repeated UI elements, cropping, resizing, conversion, and social-platform recompression can trigger measurements.",
            "No dataset-backed precision, recall, or false-positive rate is available for this build.",
            "See each module for its thresholds, measurements, and specific limitations.",
        ],
        "processingTimeMs": round((time.perf_counter() - started) * 1000),
    }


def main() -> None:
    import sys

    try:
        payload = sys.stdin.buffer.read(MAX_IMAGE_BYTES + 1)
        request = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
        result = analyze_screenshot(
            payload,
            str(request.get("fileName", "screenshot.png")),
            str(request.get("category", "other")),
            float(request.get("sensitivity", 3.0)),
        )
        print(json.dumps(result, separators=(",", ":"), ensure_ascii=True))
    except ValueError as error:
        print(json.dumps({"error": str(error)}))
        sys.exit(2)


if __name__ == "__main__":
    main()
