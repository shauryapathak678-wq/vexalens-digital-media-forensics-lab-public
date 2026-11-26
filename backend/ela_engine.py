"""Cautious, in-memory Error Level Analysis using Pillow and NumPy."""

import base64
import io
import re
from typing import Any, Dict, List, Literal, Optional, Tuple

import numpy as np
from PIL import ExifTags, Image, ImageFilter, ImageOps

ChannelMode = Literal["rgb", "r", "g", "b", "luminance"]
BLOCK_SIZE = 32
Z_THRESHOLD = 6.0
GLOBAL_COVERAGE_THRESHOLD = 20.0
MAX_DIMENSION = 2400

_LUMA_QTABLE = np.array([
    16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55,
    14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
    18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92,
    49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
])
_CHROMA_QTABLE = np.array([
    17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99,
    24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
])


def _estimate_jpeg_quality(image: Image.Image) -> Optional[int]:
    tables = getattr(image, "quantization", None)
    if not tables:
        return None

    estimates: List[int] = []
    standard_tables = (_LUMA_QTABLE, _CHROMA_QTABLE)
    for table in tables.values():
        observed = np.sort(np.asarray(table, dtype=np.float64))
        if observed.size != 64:
            continue
        best_error = float("inf")
        best_quality = 0
        for standard in standard_tables:
            sorted_standard = np.sort(standard)
            for quality in range(1, 101):
                scale = 5000 / quality if quality < 50 else 200 - 2 * quality
                expected = np.clip(np.floor((sorted_standard * scale + 50) / 100), 1, 255)
                error = float(np.mean(np.abs(observed - np.sort(expected))))
                if error < best_error:
                    best_error = error
                    best_quality = quality
        if best_error <= 2.0:
            estimates.append(best_quality)
    return int(round(float(np.median(estimates)))) if estimates else None


def _metadata_text(exif: Dict[int, Any]) -> Tuple[Dict[str, str], str]:
    tags: Dict[str, str] = {}
    for tag_id, value in exif.items():
        name = ExifTags.TAGS.get(tag_id, str(tag_id))
        if isinstance(value, bytes):
            value = value.decode("utf-8", errors="ignore")
        if isinstance(value, (str, int, float)):
            tags[name] = str(value).strip("\x00 ")
    return tags, " ".join(tags.values())


def _find_ai_origin_signals(image_bytes: bytes, metadata_text: str) -> Dict[str, Any]:
    signals: List[str] = []
    searchable = metadata_text
    content_sample = image_bytes[: min(len(image_bytes), 2 * 1024 * 1024)].decode("latin-1", errors="ignore")
    has_c2pa = bool(re.search(r"c2pa|content credentials|jumbf", content_sample, re.IGNORECASE))
    combined = f"{searchable} {content_sample}"

    patterns = [
        (r"midjourney", "Midjourney"),
        (r"dall[\s._-]?e", "DALL-E"),
        (r"stable[\s._-]?diffusion", "Stable Diffusion"),
        (r"comfyui", "ComfyUI"),
        (r"automatic1111", "Automatic1111"),
        (r"invokeai", "InvokeAI"),
        (r"novelai", "NovelAI"),
        (r"adobe[\s._-]?firefly", "Adobe Firefly"),
        (r"google[\s._-]?imagen", "Google Imagen"),
        (r"\bflux(?:\.1)?\b", "Flux"),
        (r"trainedalgorithmicmedia", "IPTC trainedAlgorithmicMedia"),
    ]
    for expression, name in patterns:
        if re.search(expression, combined, re.IGNORECASE):
            signals.append(f"Metadata signature detected: {name}")

    if has_c2pa and re.search(r"trainedalgorithmicmedia", combined, re.IGNORECASE):
        signals.append("Content Credentials metadata declares trainedAlgorithmicMedia.")

    signals = list(dict.fromkeys(signals))
    return {
        "status": "signals_found" if signals else "none_found",
        "signals": signals,
        "details": "; ".join(signals) if signals else
            "No AI-origin signals found in metadata (this does NOT prove the image is real).",
        "has_c2pa_marker": has_c2pa,
    }


def _sobel_edge_magnitude(rgb: np.ndarray) -> np.ndarray:
    gray = (
        0.299 * rgb[:, :, 0].astype(np.float32)
        + 0.587 * rgb[:, :, 1].astype(np.float32)
        + 0.114 * rgb[:, :, 2].astype(np.float32)
    )
    padded = np.pad(gray, 1, mode="edge")
    gx = (
        padded[:-2, 2:] + 2 * padded[1:-1, 2:] + padded[2:, 2:]
        - padded[:-2, :-2] - 2 * padded[1:-1, :-2] - padded[2:, :-2]
    )
    gy = (
        padded[2:, :-2] + 2 * padded[2:, 1:-1] + padded[2:, 2:]
        - padded[:-2, :-2] - 2 * padded[:-2, 1:-1] - padded[:-2, 2:]
    )
    return np.hypot(gx, gy) / 4.0


def detect_hotspots_np(
    diff_map: np.ndarray,
    block_size: int = BLOCK_SIZE,
    z_threshold: float = Z_THRESHOLD,
    edge_magnitude: Optional[np.ndarray] = None,
) -> Tuple[List[Dict[str, Any]], bool, Dict[str, Any]]:
    """Find connected anomalous block components using median/MAD statistics."""
    height, width = diff_map.shape
    rows = (height + block_size - 1) // block_size
    cols = (width + block_size - 1) // block_size
    block_means = np.zeros((rows, cols), dtype=np.float64)
    edge_means = np.zeros((rows, cols), dtype=np.float64)

    for row in range(rows):
        y0, y1 = row * block_size, min(height, (row + 1) * block_size)
        for col in range(cols):
            x0, x1 = col * block_size, min(width, (col + 1) * block_size)
            block_means[row, col] = float(np.mean(diff_map[y0:y1, x0:x1]))
            if edge_magnitude is not None:
                edge_means[row, col] = float(np.mean(edge_magnitude[y0:y1, x0:x1]))

    edge_baseline = float(np.median(edge_means)) if edge_magnitude is not None else 0.0
    adjusted = block_means.copy()
    if edge_magnitude is not None:
        strong_edges = edge_means > max(8.0, edge_baseline * 1.75)
        adjusted[strong_edges] *= 0.5

    median_value = float(np.median(adjusted))
    mad_value = float(np.median(np.abs(adjusted - median_value)))
    scaled_mad = 1.4826 * mad_value
    scale = max(scaled_mad, 1e-6)
    z_grid = (adjusted - median_value) / scale
    anomalous = z_grid > z_threshold
    anomalous_count = int(np.count_nonzero(anomalous))
    coverage_pct = 100.0 * anomalous_count / max(1, rows * cols)

    # A uniformly elevated block baseline is diffuse recompression, not a local edit.
    block_iqr = float(np.percentile(adjusted, 75) - np.percentile(adjusted, 25))
    is_global = coverage_pct > GLOBAL_COVERAGE_THRESHOLD or (
        median_value >= 3.0 and block_iqr < median_value * 0.35
    )
    stats = {
        "median": round(median_value, 3),
        "mad": round(mad_value, 3),
        "scaled_mad": round(scaled_mad, 3),
        "total_blocks": rows * cols,
        "anomalous_blocks": anomalous_count,
        "coverage_pct": round(coverage_pct, 1),
        "block_iqr": round(block_iqr, 3),
    }
    if is_global:
        return [], True, stats

    visited = np.zeros((rows, cols), dtype=bool)
    hotspots: List[Dict[str, Any]] = []
    for row in range(rows):
        for col in range(cols):
            if not anomalous[row, col] or visited[row, col]:
                continue
            queue = [(row, col)]
            visited[row, col] = True
            component: List[Tuple[int, int]] = []
            while queue:
                current_row, current_col = queue.pop()
                component.append((current_row, current_col))
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        nr, nc = current_row + dy, current_col + dx
                        if (
                            0 <= nr < rows and 0 <= nc < cols
                            and anomalous[nr, nc] and not visited[nr, nc]
                        ):
                            visited[nr, nc] = True
                            queue.append((nr, nc))

            if len(component) < 3:
                continue
            min_row = min(point[0] for point in component)
            max_row = max(point[0] for point in component)
            min_col = min(point[1] for point in component)
            max_col = max(point[1] for point in component)
            x, y = min_col * block_size, min_row * block_size
            box_width = min(width - x, (max_col - min_col + 1) * block_size)
            box_height = min(height - y, (max_row - min_row + 1) * block_size)
            component_z = [float(z_grid[r, c]) for r, c in component]
            hotspots.append({
                "x": x,
                "y": y,
                "w": box_width,
                "h": box_height,
                "area_pct": round(100.0 * box_width * box_height / (width * height), 2),
                "mean_z": round(float(np.mean(component_z)), 2),
                "peak_z": round(float(np.max(component_z)), 2),
            })

    stats["components"] = len(hotspots)
    return hotspots, False, stats


def _reliability_assessment(
    image: Image.Image,
    file_name: str,
    exif_tags: Dict[str, str],
    estimated_quality: Optional[int],
) -> Tuple[str, List[str]]:
    reasons: List[str] = []
    format_name = (image.format or "").upper()
    is_jpeg = format_name in ("JPEG", "JPG")
    if not is_jpeg:
        reasons.append(f"{format_name or 'Unknown'} input is not JPEG; ELA is not applicable to its original compression history.")

    metadata_text = " ".join([file_name, *exif_tags.values()])
    messaging_app = re.search(
        r"whatsapp|telegram|instagram|facebook|fb_img|signal|messenger|wechat",
        metadata_text,
        re.IGNORECASE,
    )
    if messaging_app:
        reasons.append(f"Filename or metadata suggests a messaging/social-app export ({messaging_app.group(0)}).")

    has_exif = bool(exif_tags)
    if not has_exif:
        reasons.append("No EXIF metadata was found; the original capture and recompression history cannot be confirmed.")

    width, height = image.size
    is_typical_app_size = max(width, height) in (720, 960, 1024, 1280, 1600)
    if is_typical_app_size:
        reasons.append(f"Dimensions ({width}×{height}) match a common social-app resize limit.")

    if estimated_quality is not None and estimated_quality < 70:
        reasons.append(f"JPEG quantization tables estimate quality {estimated_quality}/100, below the 70 reliability threshold.")

    low = (
        not is_jpeg
        or messaging_app is not None
        or (estimated_quality is not None and estimated_quality < 70)
        or (not has_exif and is_typical_app_size)
        or (not has_exif and messaging_app is not None)
    )
    if low:
        return "low", reasons
    if not has_exif or is_typical_app_size:
        return "medium", reasons
    return "high", reasons


def _perceptual_colormap(normalized: np.ndarray) -> np.ndarray:
    stops = np.array([
        [15, 23, 42], [30, 58, 138], [14, 116, 144],
        [16, 185, 129], [234, 179, 8], [249, 115, 22], [239, 68, 68],
    ], dtype=np.float32)
    positions = np.array([0.0, 0.15, 0.35, 0.55, 0.72, 0.88, 1.0], dtype=np.float32)
    flat = np.clip(normalized, 0.0, 1.0).ravel()
    result = np.empty((flat.size, 3), dtype=np.uint8)
    for channel in range(3):
        result[:, channel] = np.interp(flat, positions, stops[:, channel]).astype(np.uint8)
    return result.reshape((*normalized.shape, 3))


def perform_ela(
    image_bytes: bytes,
    quality: int = 95,
    multiplier: float = 1.0,
    channel: ChannelMode = "rgb",
    invert: bool = False,
    luminance_only: bool = False,
    file_name: str = "image.jpg",
    z_threshold: float = Z_THRESHOLD,
) -> Dict[str, Any]:
    """Run ELA and return one structured, cautious result object."""
    quality = max(1, min(95, int(quality)))
    multiplier = max(0.5, min(5.0, float(multiplier)))
    z_threshold = max(1.0, min(20.0, float(z_threshold)))
    try:
        source_image = Image.open(io.BytesIO(image_bytes))
        source_image.load()
    except Exception as exc:
        raise ValueError(f"Invalid or corrupted image data: {exc}") from exc

    original_format = (source_image.format or "").upper()
    exif, exif_text = _metadata_text(source_image.getexif())
    estimated_quality = _estimate_jpeg_quality(source_image)
    reliability, reliability_reasons = _reliability_assessment(
        source_image, file_name, exif, estimated_quality
    )
    working_image = ImageOps.exif_transpose(source_image).convert("RGB")
    if max(working_image.size) > MAX_DIMENSION:
        working_image.thumbnail((MAX_DIMENSION, MAX_DIMENSION), Image.Resampling.LANCZOS)
    width, height = working_image.size
    rgb = np.asarray(working_image, dtype=np.float32)

    resaved_buffer = io.BytesIO()
    working_image.save(resaved_buffer, format="JPEG", quality=quality)
    resaved_buffer.seek(0)
    resaved = Image.open(resaved_buffer).convert("RGB")
    recompressed = np.asarray(resaved, dtype=np.float32)
    rgb_diff = np.abs(rgb - recompressed)
    if luminance_only or channel == "luminance":
        diff_map = 0.299 * rgb_diff[:, :, 0] + 0.587 * rgb_diff[:, :, 1] + 0.114 * rgb_diff[:, :, 2]
    elif channel == "r":
        diff_map = rgb_diff[:, :, 0]
    elif channel == "g":
        diff_map = rgb_diff[:, :, 1]
    elif channel == "b":
        diff_map = rgb_diff[:, :, 2]
    else:
        diff_map = np.mean(rgb_diff, axis=2)

    mean_error = float(np.mean(diff_map))
    p99 = float(np.percentile(diff_map, 99))
    normalizer = max(p99, 1.0)
    normalized = np.clip(diff_map / normalizer * multiplier, 0.0, 1.0)
    if invert:
        normalized = 1.0 - normalized
    heatmap_buffer = io.BytesIO()
    Image.fromarray(_perceptual_colormap(normalized), mode="RGB").save(heatmap_buffer, format="PNG")

    edge_magnitude = _sobel_edge_magnitude(rgb)
    hotspots, is_global, block_stats = detect_hotspots_np(
        diff_map, BLOCK_SIZE, z_threshold, edge_magnitude
    )
    if reliability == "low":
        verdict = "not_reliable"
    elif is_global:
        verdict = "global_recompression"
    elif hotspots:
        verdict = "possible_local_edit"
    else:
        verdict = "no_local_edits_detected"

    ai_origin = _find_ai_origin_signals(image_bytes, exif_text)
    exif_summary = {
        "hasExif": bool(exif),
        "cameraMake": exif.get("Make"),
        "cameraModel": exif.get("Model"),
        "software": exif.get("Software"),
        "format": original_format,
        "width": width,
        "height": height,
        "estimatedJpegQuality": estimated_quality,
    }
    structured = {
        "reliability": reliability,
        "reliability_reasons": reliability_reasons,
        "ela_verdict": verdict,
        "hotspots": hotspots,
        "exif_summary": exif_summary,
        "ai_origin": {
            "status": ai_origin["status"],
            "signals": ai_origin["signals"],
        },
        "metrics": {
            "resave_quality": quality,
            "block_size": BLOCK_SIZE,
            "z_threshold": z_threshold,
            **block_stats,
            "p99_diff": round(p99, 3),
            "mean_diff": round(mean_error, 3),
        },
    }
    return {
        **structured,
        "data_url": "data:image/png;base64," + base64.b64encode(heatmap_buffer.getvalue()).decode("ascii"),
        "width": width,
        "height": height,
        "mean_error": round(mean_error, 3),
        "max_error": round(float(np.max(diff_map)), 3),
        "variance": round(float(np.var(diff_map)), 3),
        "standard_deviation": round(float(np.std(diff_map)), 3),
        "quality": quality,
        "multiplier": multiplier,
        "channel": channel,
        "invert": invert,
        "p99": round(p99, 3),
        "is_jpeg": original_format in ("JPEG", "JPG"),
        "format_warning": reliability_reasons[0] if original_format not in ("JPEG", "JPG") else None,
        "quality_warning": (
            "Resave quality below 90% can increase recompression artifacts and reduce interpretability."
            if quality < 90 else None
        ),
        "is_global_pattern": is_global,
        "block_stats": block_stats,
        "exif_summary": exif_summary,
        "ai_origin_details": ai_origin["details"],
        "disclaimer": (
            "ELA detects local compression differences in JPEGs. It cannot prove AI generation or authenticity; "
            "it is unreliable on files re-shared through messaging or social apps."
        ),
        "hotspot_summary": (
            "Global error pattern, not a local edit."
            if is_global else
            "Localized compression anomalies are informational only and do not prove editing."
            if hotspots else
            "No localized anomalies met the configured block threshold."
        ),
    }
