"""
Age estimation using the Everypixel Faces API.

Setup:
    pip install requests
    export EVERYPIXEL_CLIENT_ID="your-client-id"
    export EVERYPIXEL_CLIENT_SECRET="your-client-secret"

Usage as a script:
    python everypixel_age.py photo.jpg
    python everypixel_age.py https://example.com/photo.jpg --min-score 0.9

Usage as a module:
    from everypixel_age import EverypixelAgeClient

    client = EverypixelAgeClient()           # reads credentials from env vars
    faces = client.estimate("photo.jpg")     # local path or http(s) URL
    for f in faces:
        print(f.age, f.age_group, f.score, f.bbox)
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import List, Optional, Union

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

API_URL = "https://api.everypixel.com/v1/faces"
ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png"}
MAX_FILE_BYTES = 10 * 1024 * 1024  # conservative client-side limit (10 MB)


class EverypixelError(Exception):
    """Raised for any API, network, or input problem."""


@dataclass
class Face:
    age: float                      # estimated age in years
    score: float                    # detection confidence, 0..1
    bbox: List[float]               # [x_min, y_min, x_max, y_max]
    age_group: str                  # e.g. "Young Adult" (API "class" without "Age - ")

    @property
    def age_rounded(self) -> int:
        return round(self.age)


class EverypixelAgeClient:
    def __init__(
        self,
        client_id: Optional[str] = None,
        client_secret: Optional[str] = None,
        timeout: float = 30.0,
        max_retries: int = 3,
    ) -> None:
        self.client_id = client_id or os.getenv("EVERYPIXEL_CLIENT_ID")
        self.client_secret = client_secret or os.getenv("EVERYPIXEL_CLIENT_SECRET")
        if not self.client_id or not self.client_secret:
            raise EverypixelError(
                "Missing credentials. Set EVERYPIXEL_CLIENT_ID and "
                "EVERYPIXEL_CLIENT_SECRET or pass them to the constructor."
            )
        self.timeout = timeout

        # Reuse the connection and retry transient failures (rate limit / 5xx).
        retry = Retry(
            total=max_retries,
            backoff_factor=1.0,
            status_forcelist=(500, 502, 503, 504),
            allowed_methods=frozenset(["GET", "POST"]),
            respect_retry_after_header=True,
        )
        self.session = requests.Session()
        self.session.mount("https://", HTTPAdapter(max_retries=retry))
        self.session.auth = (self.client_id, self.client_secret)

    # ------------------------------------------------------------------ public

    def estimate(
        self,
        source: Union[str, Path],
        min_score: float = 0.0,
    ) -> List[Face]:
        """
        Estimate ages for all faces in an image.

        source:    local file path (JPEG/PNG) or an http(s) image URL
        min_score: drop detections with confidence below this value (0..1)
        """
        source_str = str(source)
        if source_str.lower().startswith(("http://", "https://")):
            payload = self._request_url(source_str)
        else:
            payload = self._request_file(Path(source_str))

        faces = [self._parse_face(f) for f in payload.get("faces", [])]
        faces = [f for f in faces if f.score >= min_score]
        # Largest face first (usually the main subject)
        faces.sort(key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]), reverse=True)
        return faces

    def estimate_main_face(self, source: Union[str, Path], min_score: float = 0.5) -> Optional[Face]:
        """Convenience: return only the most prominent face, or None if none found."""
        faces = self.estimate(source, min_score=min_score)
        return faces[0] if faces else None

    # ----------------------------------------------------------------- private

    def _request_url(self, url: str) -> dict:
        # `params` handles URL-encoding of special characters (? & etc.).
        resp = self._send("GET", params={"url": url})
        return self._handle(resp)

    def _request_file(self, path: Path) -> dict:
        if not path.is_file():
            raise EverypixelError(f"File not found: {path}")
        if path.suffix.lower() not in ALLOWED_EXTENSIONS:
            raise EverypixelError("Only JPEG and PNG images are supported.")
        if path.stat().st_size > MAX_FILE_BYTES:
            raise EverypixelError(f"File too large (> {MAX_FILE_BYTES // (1024 * 1024)} MB).")

        mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        with path.open("rb") as fh:
            resp = self._send("POST", files={"data": (path.name, fh, mime)})
        return self._handle(resp)

    def _send(self, method: str, **kwargs) -> requests.Response:
        try:
            return self.session.request(method, API_URL, timeout=self.timeout, **kwargs)
        except requests.exceptions.RequestException as exc:
            raise EverypixelError(f"Network error: {exc}") from exc

    @staticmethod
    def _handle(resp: requests.Response) -> dict:
        if resp.status_code == 401:
            raise EverypixelError("Authentication failed: check your Client ID / Secret.")
        if resp.status_code == 429:
            raise EverypixelError(
                "HTTP 429: too many requests or no quota left. Wait a minute and retry, "
                "and check your balance/plan at https://labs.everypixel.com/account."
            )
        if not resp.ok:
            raise EverypixelError(f"API error {resp.status_code}: {resp.text[:300]}")
        try:
            data = resp.json()
        except ValueError as exc:
            raise EverypixelError("API returned invalid JSON.") from exc
        if data.get("status") != "ok":
            raise EverypixelError(f"Unexpected API response: {data}")
        return data

    @staticmethod
    def _parse_face(raw: dict) -> Face:
        label = str(raw.get("class", "")).replace("Age - ", "").strip()
        return Face(
            age=float(raw["age"]),
            score=float(raw["score"]),
            bbox=[float(v) for v in raw["bbox"]],
            age_group=label,
        )


# ------------------------------------------------------------------------ CLI

def main() -> int:
    parser = argparse.ArgumentParser(description="Estimate age from faces in an image.")
    parser.add_argument("source", help="Path to a JPEG/PNG file or an image URL")
    parser.add_argument("--min-score", type=float, default=0.5,
                        help="Minimum face confidence 0..1 (default: 0.5)")
    parser.add_argument("--json", action="store_true", help="Print raw JSON output")
    args = parser.parse_args()

    try:
        client = EverypixelAgeClient()
        faces = client.estimate(args.source, min_score=args.min_score)
    except EverypixelError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps([asdict(f) for f in faces], indent=2))
        return 0

    if not faces:
        print("No faces detected.")
        return 0

    for i, f in enumerate(faces, 1):
        print(f"Face {i}: ~{f.age:.1f} years ({f.age_group}), confidence {f.score:.3f}, bbox {f.bbox}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
