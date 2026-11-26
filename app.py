"""Local Flask interface for finding GPS coordinates in image EXIF metadata."""

from __future__ import annotations

import base64
import io
import tempfile
import warnings
from pathlib import Path
from typing import Any

from flask import Flask, render_template, request
from PIL import Image, ImageOps, UnidentifiedImageError

from gps_tracker import get_gps

ALLOWED_EXTENSIONS = {"jpg", "jpeg", "png", "heic", "tiff"}
MAX_UPLOAD_BYTES = 20 * 1024 * 1024
ALLOWED_IMAGE_FORMATS = {"JPEG", "PNG", "HEIF", "TIFF"}

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_BYTES


class InvalidImageError(ValueError):
    """Raised when an upload is not a supported, readable image."""


def _make_preview(image_bytes: bytes) -> str:
    """Create an in-memory JPEG preview so the uploaded photo is never retained."""
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(image_bytes)) as source:
                if source.format not in ALLOWED_IMAGE_FORMATS:
                    raise InvalidImageError("The file contents are not a supported image.")
                image = ImageOps.exif_transpose(source)
                image.thumbnail((1400, 1400))
                if image.mode not in ("RGB", "L"):
                    image = image.convert("RGB")
                elif image.mode == "L":
                    image = image.convert("RGB")
                output = io.BytesIO()
                image.save(output, format="JPEG", quality=85, optimize=True)
    except InvalidImageError:
        raise
    except (
        Image.DecompressionBombError,
        Image.DecompressionBombWarning,
        UnidentifiedImageError,
        OSError,
        ValueError,
        TypeError,
    ) as exc:
        raise InvalidImageError(
            "We couldn't read that image. Please choose a valid JPG, PNG, HEIC, or TIFF file."
        ) from exc

    encoded = base64.b64encode(output.getvalue()).decode("ascii")
    return f"data:image/jpeg;base64,{encoded}"


def _render_page(
    *,
    error: str | None = None,
    gps: dict[str, Any] | None = None,
    preview: str | None = None,
) -> str:
    return render_template("index.html", error=error, gps=gps, preview=preview)


@app.errorhandler(413)
def request_too_large(_error: Exception) -> tuple[str, int]:
    return _render_page(error="That file is over the 20 MB upload limit."), 413


@app.route("/", methods=["GET", "POST"])
def index() -> str | tuple[str, int]:
    if request.method == "GET":
        return _render_page()

    upload = request.files.get("photo")
    if upload is None or not upload.filename:
        return _render_page(error="Choose a photo to continue."), 400

    extension = Path(upload.filename).suffix.lower().lstrip(".")
    if extension not in ALLOWED_EXTENSIONS:
        return _render_page(
            error="Please upload a JPG, JPEG, PNG, HEIC, or TIFF photo."
        ), 400

    image_bytes = upload.read()
    if not image_bytes:
        return _render_page(error="The selected file is empty."), 400
    if len(image_bytes) > MAX_UPLOAD_BYTES:
        return _render_page(error="That file is over the 20 MB upload limit."), 413

    try:
        preview = _make_preview(image_bytes)
    except InvalidImageError as exc:
        return _render_page(error=str(exc)), 400

    temporary_path: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            prefix="gps-image-tracker-", suffix=f".{extension}", delete=False
        ) as temporary_file:
            temporary_file.write(image_bytes)
            temporary_path = temporary_file.name

        gps = get_gps(temporary_path)
    except OSError:
        app.logger.exception("Unable to process temporary image upload.")
        return _render_page(
            error="The photo could not be processed. Please try another image."
        ), 500
    finally:
        if temporary_path is not None:
            try:
                Path(temporary_path).unlink(missing_ok=True)
            except OSError:
                app.logger.exception("Unable to remove temporary image upload.")

    return _render_page(gps=gps, preview=preview)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=False)
