"""Read capture location and basic camera details from an image's EXIF tags."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Sequence

from PIL import Image, UnidentifiedImageError

try:
    from pillow_heif import register_heif_opener
except ImportError:
    register_heif_opener = None

if register_heif_opener is not None:
    register_heif_opener()

GPS_IFD_TAG = 0x8825
EXIF_IFD_TAG = 0x8769


def _as_float(value: Any) -> float:
    """Convert Pillow's EXIF rational values, or ordinary numbers, to floats."""
    if hasattr(value, "numerator") and hasattr(value, "denominator"):
        denominator = value.denominator
        if denominator == 0:
            raise ValueError("Invalid EXIF rational with a zero denominator.")
        return float(value.numerator) / float(denominator)
    if isinstance(value, tuple) and len(value) == 2:
        numerator, denominator = value
        if denominator == 0:
            raise ValueError("Invalid EXIF rational with a zero denominator.")
        return float(numerator) / float(denominator)
    return float(value)


def _reference_text(reference: Any) -> str:
    if isinstance(reference, bytes):
        return reference.decode("ascii", errors="ignore").strip("\x00 ").upper()
    return str(reference).strip("\x00 ").upper()


def dms_to_decimal(
    degrees_minutes_seconds: Sequence[Any], reference: Any = None
) -> float:
    """Convert EXIF degrees/minutes/seconds to decimal degrees and apply its hemisphere."""
    if len(degrees_minutes_seconds) < 3:
        raise ValueError("A coordinate must contain degrees, minutes, and seconds.")

    degrees, minutes, seconds = (
        _as_float(degrees_minutes_seconds[index]) for index in range(3)
    )
    decimal = abs(degrees) + minutes / 60.0 + seconds / 3600.0
    direction = _reference_text(reference) if reference is not None else ""

    if direction in {"S", "W"}:
        return -decimal
    if direction in {"N", "E", ""}:
        return decimal
    raise ValueError(f"Unrecognized coordinate reference: {direction}")


def _text_or_none(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, bytes):
        value = value.decode("utf-8", errors="replace")
    cleaned = str(value).strip().strip("\x00")
    return cleaned or None


def _read_gps(image: Image.Image) -> dict[str, Any] | None:
    exif = image.getexif()
    gps = exif.get_ifd(GPS_IFD_TAG)
    if not gps:
        return None

    latitude = gps.get(2)
    latitude_ref = gps.get(1)
    longitude = gps.get(4)
    longitude_ref = gps.get(3)
    if latitude is None or latitude_ref is None or longitude is None or longitude_ref is None:
        return None

    decimal_latitude = dms_to_decimal(latitude, latitude_ref)
    decimal_longitude = dms_to_decimal(longitude, longitude_ref)
    if not -90 <= decimal_latitude <= 90 or not -180 <= decimal_longitude <= 180:
        return None

    altitude: float | None = None
    if gps.get(6) is not None:
        altitude = _as_float(gps[6])
        if gps.get(5) in (1, b"\x01", "\x01"):
            altitude = -abs(altitude)

    exif_ifd = exif.get_ifd(EXIF_IFD_TAG)
    date_time = _text_or_none(exif_ifd.get(0x9003))

    return {
        "latitude": decimal_latitude,
        "longitude": decimal_longitude,
        "altitude": altitude,
        "date_time": date_time,
        "camera_make": _text_or_none(exif.get(0x010F)),
        "camera_model": _text_or_none(exif.get(0x0110)),
    }


def get_gps(image_path: str | Path) -> dict[str, Any] | None:
    """Return GPS coordinates and available capture/camera details, or None.

    Unreadable images, malformed EXIF, and images without complete GPS
    coordinates are treated as having no usable GPS result.
    """
    try:
        with Image.open(image_path) as image:
            return _read_gps(image)
    except (
        Image.DecompressionBombError,
        Image.DecompressionBombWarning,
        UnidentifiedImageError,
        OSError,
        ValueError,
        TypeError,
        KeyError,
        IndexError,
        ZeroDivisionError,
        OverflowError,
    ):
        return None


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: python gps_tracker.py <photo>")
        return 2
    print(json.dumps(get_gps(sys.argv[1]), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
