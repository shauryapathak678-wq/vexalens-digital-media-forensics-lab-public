import asyncio
import copy
import hashlib
import hmac
import html
import http.client
import ipaddress
import json
import logging
import math
import os
import re
import socket
import sqlite3
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import warnings
from contextlib import closing
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from typing import Any, Awaitable, Callable
from urllib.parse import parse_qsl, quote, urlencode, urljoin, urlsplit, urlunsplit

import cv2
import imagehash
import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError

from backend.image_trace_providers import (
    ENGINE_TIMEOUT_SECONDS as PROVIDER_ENGINE_TIMEOUT_SECONDS,
    ProviderRequestError,
    missing_provider_settings,
    request_provider,
)

logger = logging.getLogger(__name__)

MAX_IMAGE_BYTES = 15 * 1024 * 1024
MAX_IMAGE_PIXELS = 40_000_000
ENGINE_TIMEOUT_SECONDS = PROVIDER_ENGINE_TIMEOUT_SECONDS
DOWNLOAD_TIMEOUT_SECONDS = 10
MAX_DOWNLOAD_BYTES = 15 * 1024 * 1024
TRACE_ENGINE_TIMEOUT_SECONDS = ENGINE_TIMEOUT_SECONDS
TRACE_VERIFY_TIMEOUT_SECONDS = 5
TRACE_VERIFY_MAX_DOWNLOAD_BYTES = 3 * 1024 * 1024
TRACE_VERIFY_CONCURRENCY = 8
TRACE_VERIFY_MAX_RESULTS = 30
SEARCH_CACHE_TTL_SECONDS = 60 * 60
MAX_ENGINE_RESULTS = 50
MAX_KNOWN_LINKS = 20
MAX_IMAGES_PER_KNOWN_LINK = 50
GALLERY_DL_TIMEOUT_SECONDS = 30
MAX_REDIRECTS = 3
SUPPORTED_ENGINES = ("google_vision", "yandex", "tineye")
SUPPORTED_IMAGE_FORMATS = {"JPEG", "PNG", "WEBP", "GIF"}
SOCIAL_PLATFORMS = (
    "Instagram",
    "Facebook",
    "X / Twitter",
    "TikTok",
    "YouTube",
    "Reddit",
    "Pinterest",
    "LinkedIn",
    "Telegram",
    "VK",
    "Tumblr",
    "Flickr",
)
_TRACKING_PARAMETERS = {
    "fbclid",
    "gclid",
    "dclid",
    "mc_cid",
    "mc_eid",
    "igshid",
    "ref_src",
}
_GENESIS_HASH = "0" * 64
_search_cache: dict[tuple[str, tuple[str, ...], bool], tuple[float, dict[str, Any]]] = {}
_search_cache_lock = threading.Lock()


class ImageTraceInputError(ValueError):
    pass


class UnsafeImageUrlError(ValueError):
    pass


def decode_image(data: bytes) -> tuple[Image.Image, str]:
    if not data:
        raise ImageTraceInputError("Upload a non-empty image.")
    if len(data) > MAX_IMAGE_BYTES:
        raise ImageTraceInputError("Image exceeds the 15 MiB upload limit.")

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(data)) as probe:
                image_format = (probe.format or "").upper()
                if image_format not in SUPPORTED_IMAGE_FORMATS:
                    raise ImageTraceInputError("Only JPEG, PNG, WebP, and GIF images are supported.")
                if probe.width <= 0 or probe.height <= 0 or probe.width * probe.height > MAX_IMAGE_PIXELS:
                    raise ImageTraceInputError("Image dimensions exceed the 40-megapixel safety limit.")
                probe.verify()
            with Image.open(BytesIO(data)) as source:
                source.seek(0)
                image = ImageOps.exif_transpose(source.copy()).convert("RGB")
                image.load()
    except ImageTraceInputError:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise ImageTraceInputError("Image dimensions exceed the 40-megapixel safety limit.") from None
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise ImageTraceInputError("The uploaded bytes are not a readable supported image.") from exc

    return image, image_format


def _hash_similarity(first: imagehash.ImageHash, second: imagehash.ImageHash) -> float:
    return round(max(0.0, (1.0 - (first - second) / 64) * 100), 1)


def phash_similarity(first: Image.Image, second: Image.Image) -> float:
    first_hash = imagehash.phash(first, hash_size=8)
    second_hash = imagehash.phash(second, hash_size=8)
    return _hash_similarity(first_hash, second_hash)


def orb_similarity(first: Image.Image, second: Image.Image) -> float:
    def grayscale(image: Image.Image) -> np.ndarray:
        frame = np.asarray(image.convert("RGB"))
        height, width = frame.shape[:2]
        scale = min(1.0, 1024 / max(height, width))
        if scale < 1:
            frame = cv2.resize(
                frame,
                (max(1, round(width * scale)), max(1, round(height * scale))),
                interpolation=cv2.INTER_AREA,
            )
        return cv2.cvtColor(frame, cv2.COLOR_RGB2GRAY)

    orb = cv2.ORB_create(nfeatures=1200)
    first_points, first_descriptors = orb.detectAndCompute(grayscale(first), None)
    second_points, second_descriptors = orb.detectAndCompute(grayscale(second), None)
    if first_descriptors is None or second_descriptors is None:
        return 0.0
    denominator = min(len(first_points), len(second_points))
    if denominator < 12:
        return 0.0

    pairs = cv2.BFMatcher(cv2.NORM_HAMMING).knnMatch(first_descriptors, second_descriptors, k=2)
    matches = [pair[0] for pair in pairs if len(pair) == 2 and pair[0].distance < 0.75 * pair[1].distance]
    if len(matches) < 12:
        return 0.0

    first_coordinates = np.float32([first_points[match.queryIdx].pt for match in matches]).reshape(-1, 1, 2)
    second_coordinates = np.float32([second_points[match.trainIdx].pt for match in matches]).reshape(-1, 1, 2)
    _, inliers = cv2.findHomography(first_coordinates, second_coordinates, cv2.RANSAC, 5.0)
    if inliers is None:
        return 0.0
    inlier_count = int(inliers.sum())
    if inlier_count < 12:
        return 0.0
    return round(min(100.0, inlier_count / denominator * 100), 1)


def compare_images(first: Image.Image, second: Image.Image) -> float:
    perceptual = _hash_similarity(imagehash.phash(first, hash_size=8), imagehash.phash(second, hash_size=8))
    difference = _hash_similarity(imagehash.dhash(first, hash_size=8), imagehash.dhash(second, hash_size=8))
    return float(max(perceptual, difference, orb_similarity(first, second)))


def normalize_result_url(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip() or len(value) > 4096:
        return None
    raw = value.strip()
    if any(ord(char) < 32 for char in raw):
        return None
    try:
        parsed = urlsplit(raw)
        scheme = parsed.scheme.lower()
        hostname = parsed.hostname
        if scheme not in {"http", "https"} or not hostname or parsed.username or parsed.password:
            return None
        host = hostname.encode("idna").decode("ascii").lower().rstrip(".")
        port = parsed.port
    except (UnicodeError, ValueError):
        return None

    if port == 0:
        return None
    if host in {"localhost", "localhost.localdomain"} or host.endswith((".localhost", ".local")):
        return None
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    if address is not None and not address.is_global:
        return None

    if ":" in host:
        host = f"[{host}]"
    if port and not ((scheme == "http" and port == 80) or (scheme == "https" and port == 443)):
        host = f"{host}:{port}"

    query = [
        (key, item)
        for key, item in parse_qsl(parsed.query, keep_blank_values=True)
        if not key.lower().startswith("utm_") and key.lower() not in _TRACKING_PARAMETERS
    ]
    query.sort()
    return urlunsplit((scheme, host, parsed.path or "/", urlencode(query, doseq=True), ""))


def platform_from_url(value: str) -> str:
    try:
        host = (urlsplit(value).hostname or "").encode("idna").decode("ascii").lower().rstrip(".")
    except (UnicodeError, ValueError):
        return "Unknown"

    def matches(domain: str) -> bool:
        return host == domain or host.endswith("." + domain)

    platforms = (
        (("instagram.com",), "Instagram"),
        (("facebook.com", "fb.com", "fb.watch"), "Facebook"),
        (("x.com", "twitter.com", "t.co"), "X / Twitter"),
        (("tiktok.com",), "TikTok"),
        (("youtube.com", "youtu.be"), "YouTube"),
        (("reddit.com", "redd.it"), "Reddit"),
        (("linkedin.com",), "LinkedIn"),
        (("t.me", "telegram.me", "telegram.org"), "Telegram"),
        (("vk.com",), "VK"),
        (("tumblr.com",), "Tumblr"),
        (("flickr.com",), "Flickr"),
        (("medium.com",), "Medium"),
        (("whatsapp.com", "wa.me"), "WhatsApp"),
        (("wordpress.com", "wordpress.org", "blogspot.com"), "WordPress / Blogger"),
    )
    for domains, name in platforms:
        if any(matches(domain) for domain in domains):
            return name
    if re.search(r"(^|\.)pinterest\.[a-z.]+$", host):
        return "Pinterest"
    return "Website"


def _is_search_engine_results_page(value: str) -> bool:
    try:
        parsed = urlsplit(value)
        host = (parsed.hostname or "").encode("idna").decode("ascii").lower().rstrip(".")
        path = parsed.path.rstrip("/").lower()
    except (UnicodeError, ValueError):
        return True

    if host in {"lens.google.com", "images.google.com"}:
        return True
    if host == "google.com" or host.endswith(".google.com"):
        if path.startswith(("/search", "/imgres", "/images/search")):
            return True
    if host in {
        "yandex.com",
        "yandex.ru",
        "yandex.kz",
        "yandex.by",
        "yandex.com.tr",
        "yandex.uz",
        "yandex.az",
    } and path.startswith("/images"):
        return True
    if host == "bing.com" or host.endswith(".bing.com"):
        if path.startswith(("/images/search", "/visualsearch")):
            return True
    if host == "tineye.com" or host.endswith(".tineye.com"):
        if path.startswith("/search"):
            return True
    return False


def is_social_platform(platform: str) -> bool:
    return platform in SOCIAL_PLATFORMS


def _result_from_provider(
    engine: str,
    page_url: Any,
    image_url: Any,
    title: Any,
    category: str,
    matching_images: list[str] | None = None,
) -> dict[str, Any] | None:
    normalized_page_url = normalize_result_url(page_url)
    normalized_image_url = normalize_result_url(image_url)
    result_url = normalized_page_url or normalized_image_url
    if not result_url or _is_search_engine_results_page(result_url):
        return None
    platform = platform_from_url(normalized_page_url or result_url)
    result: dict[str, Any] = {
        "engine": engine,
        "engines": [engine],
        "url": result_url,
        "image_url": normalized_image_url,
        "platform": platform,
        "social": is_social_platform(platform),
        "similarity": None,
        "verified": False,
        "category": category,
    }
    if isinstance(title, str):
        result["title"] = title[:500]
    if matching_images:
        result["matching_images"] = matching_images[:20]
    return result


def _normalize_engine_items(engine: str, payload: dict[str, Any]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    seen: set[str] = set()
    candidates: list[dict[str, Any]] = []
    if engine == "google_vision":
        responses = payload.get("responses")
        if not isinstance(responses, list) or not responses or not isinstance(responses[0], dict):
            raise ValueError("Google Vision returned an unexpected response.")
        web_detection = responses[0].get("webDetection") or {}
        if not isinstance(web_detection, dict):
            raise ValueError("Google Vision returned malformed web-detection data.")
        for page in web_detection.get("pagesWithMatchingImages", []):
            if not isinstance(page, dict):
                continue
            image_urls = [
                url
                for item in (page.get("fullMatchingImages", []) + page.get("partialMatchingImages", []))
                if isinstance(item, dict)
                and (url := normalize_result_url(item.get("url")))
            ]
            candidates.append({
                "page_url": page.get("url"),
                "image_url": image_urls[0] if image_urls else None,
                "title": page.get("pageTitle"),
                "category": "pagesWithMatchingImages",
                "matching_images": image_urls,
            })
        for field, category in (
            ("fullMatchingImages", "fullMatchingImages"),
            ("partialMatchingImages", "partialMatchingImages"),
        ):
            for item in web_detection.get(field, []):
                if isinstance(item, dict):
                    candidates.append({
                        "image_url": item.get("url"),
                        "category": category,
                    })
    elif engine == "yandex":
        items = payload.get("images")
        if items is None and isinstance(payload.get("result"), dict):
            items = payload["result"].get("images")
        if not isinstance(items, list):
            raise ValueError("Yandex returned an unexpected image-search response.")
        for item in items:
            if isinstance(item, dict):
                candidates.append({
                    "page_url": item.get("pageUrl") or item.get("page_url"),
                    "image_url": item.get("url") or item.get("imageUrl") or item.get("image_url"),
                    "title": item.get("title"),
                    "category": "image",
                })
    elif engine == "tineye":
        data = payload.get("results", payload)
        if not isinstance(data, dict) or not isinstance(data.get("matches"), list):
            raise ValueError("TinEye returned an unexpected search response.")
        for match in data["matches"]:
            if not isinstance(match, dict):
                continue
            backlinks = match.get("backlinks")
            if isinstance(backlinks, list) and backlinks:
                for backlink in backlinks:
                    if isinstance(backlink, dict):
                        candidates.append({
                            "page_url": backlink.get("url") or backlink.get("backlink"),
                            "image_url": match.get("image_url"),
                            "title": backlink.get("title") or backlink.get("domain"),
                            "category": "match",
                        })
            else:
                candidates.append({
                    "image_url": match.get("image_url"),
                    "category": "match",
                })
    else:
        raise ValueError(f"Unsupported Image Trace provider: {engine}")

    for candidate in candidates:
        result = _result_from_provider(
            engine,
            candidate.get("page_url"),
            candidate.get("image_url"),
            candidate.get("title"),
            candidate["category"],
            candidate.get("matching_images"),
        )
        if result is None or result["url"] in seen:
            continue
        seen.add(result["url"])
        normalized.append(result)
        if len(normalized) >= MAX_ENGINE_RESULTS:
            break
    return normalized


async def _search_one_engine(
    engine: str,
    image_paths: list[Path],
    deep_search: bool,
) -> tuple[str, str, list[dict[str, Any]], dict[str, Any]]:
    started = time.monotonic()
    missing = missing_provider_settings(engine)
    if missing:
        error = f"Missing server configuration: {', '.join(missing)}."
        return engine, "not_configured", [], {
            "status": "not_configured",
            "elapsed_ms": 0,
            "attempts": 0,
            "error": error,
            "error_category": "not_configured",
            "variants_searched": 0,
        }

    deadline = asyncio.get_running_loop().time() + TRACE_ENGINE_TIMEOUT_SECONDS
    results: list[dict[str, Any]] = []
    seen_urls: set[str] = set()
    errors: list[str] = []
    error_categories: list[str] = []
    http_statuses: list[int] = []
    attempts = 0
    variants_searched = 0
    full_image_status: str | None = None

    for index, image_path in enumerate(image_paths):
        if index > 0 and (
            not deep_search
            or full_image_status != "no_matches"
            or results
        ):
            break
        remaining = deadline - asyncio.get_running_loop().time()
        if remaining <= 0:
            errors.append(f"Timed out after {TRACE_ENGINE_TIMEOUT_SECONDS} seconds.")
            break
        try:
            response = await request_provider(engine, image_path.read_bytes(), remaining)
            attempts += response.attempts
            variants_searched += 1
            variant_results = _normalize_engine_items(engine, response.payload)
            if index == 0:
                full_image_status = "matches_found" if variant_results else "no_matches"
            for result in variant_results:
                if result["url"] not in seen_urls:
                    seen_urls.add(result["url"])
                    results.append(result)
        except ProviderRequestError as exc:
            attempts += exc.attempts
            errors.append(str(exc))
            error_categories.append(exc.category)
            if exc.http_status is not None:
                http_statuses.append(exc.http_status)
            if index == 0:
                full_image_status = "failed"
        except OSError as exc:
            errors.append(str(exc)[:300] or type(exc).__name__)
            error_categories.append("local_io_error")
            if index == 0:
                full_image_status = "failed"
        except ValueError as exc:
            errors.append(str(exc)[:300] or type(exc).__name__)
            error_categories.append("parse_error")
            if index == 0:
                full_image_status = "failed"
        except Exception as exc:
            logger.exception("Unexpected Image Trace provider failure for %s", engine)
            errors.append(f"Unexpected provider error ({type(exc).__name__}): {' '.join(str(exc).split())[:200]}")
            error_categories.append("unexpected_error")
            if index == 0:
                full_image_status = "failed"

        if index == 0 and full_image_status != "no_matches":
            break

    if results:
        status = "matches_found"
    elif errors:
        status = "failed"
    else:
        status = "no_matches"
    detail = {
        "status": status,
        "elapsed_ms": round((time.monotonic() - started) * 1000),
        "attempts": attempts,
        "error": "; ".join(dict.fromkeys(errors))[:1000] if errors else None,
        "error_category": ", ".join(dict.fromkeys(error_categories)) if error_categories else None,
        "http_statuses": sorted(set(http_statuses)),
        "variants_searched": variants_searched,
    }
    return engine, status, results[:MAX_ENGINE_RESULTS], detail


def _deduplicate_engine_results(collected: list[dict[str, Any]]) -> list[dict[str, Any]]:
    deduplicated: dict[str, dict[str, Any]] = {}
    for result in collected:
        current = deduplicated.get(result["url"])
        if current is None:
            deduplicated[result["url"]] = result
            continue
        for source in result["engines"]:
            if source not in current["engines"]:
                current["engines"].append(source)
        if current["image_url"] is None:
            current["image_url"] = result["image_url"]
    return list(deduplicated.values())


async def search_engines_stream(
    image_path: Path | list[Path],
    engines: list[str],
):
    image_paths = image_path if isinstance(image_path, list) else [image_path]
    async for engine, status, results, _ in search_engine_results_stream(image_paths, engines):
        yield engine, status, results


async def search_engine_results_stream(
    image_path: Path | list[Path],
    engines: list[str],
    deep_search: bool = False,
):
    image_paths = image_path if isinstance(image_path, list) else [image_path]
    tasks = [
        asyncio.create_task(_search_one_engine(engine, image_paths, deep_search))
        for engine in engines
    ]
    try:
        for completed in asyncio.as_completed(tasks):
            yield await completed
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)


async def search_engines(
    image_path: Path | list[Path],
    engines: list[str],
) -> tuple[dict[str, str], list[dict[str, Any]]]:
    statuses: dict[str, str] = {}
    collected: list[dict[str, Any]] = []
    async for engine, status, results, _ in search_engine_results_stream(image_path, engines):
        statuses[engine] = status
        collected.extend(results)
    return statuses, _deduplicate_engine_results(collected)


def _resolve_public_url(value: str) -> tuple[Any, str, int, tuple[Any, ...]]:
    if len(value) > 4096 or any(ord(char) < 32 for char in value):
        raise UnsafeImageUrlError("Invalid candidate image URL.")
    try:
        parsed = urlsplit(value)
        scheme = parsed.scheme.lower()
        hostname = parsed.hostname
        if scheme not in {"http", "https"} or not hostname or parsed.username or parsed.password:
            raise UnsafeImageUrlError("Only credential-free HTTP(S) image URLs are allowed.")
        host = hostname.encode("idna").decode("ascii").lower().rstrip(".")
        explicit_port = parsed.port
        port = explicit_port if explicit_port is not None else (443 if scheme == "https" else 80)
        if port == 0:
            raise UnsafeImageUrlError("Candidate image URL has an invalid port.")
    except (UnicodeError, ValueError) as exc:
        raise UnsafeImageUrlError("Invalid candidate image URL.") from exc

    if host in {"localhost", "localhost.localdomain"} or host.endswith((".localhost", ".local")):
        raise UnsafeImageUrlError("Local hostnames are not allowed.")
    try:
        addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise UnsafeImageUrlError("Candidate image host could not be resolved.") from exc
    if not addresses:
        raise UnsafeImageUrlError("Candidate image host did not resolve.")
    for address in addresses:
        try:
            ip = ipaddress.ip_address(address[4][0].split("%", 1)[0])
        except ValueError as exc:
            raise UnsafeImageUrlError("Candidate image host returned an invalid address.") from exc
        if not ip.is_global:
            raise UnsafeImageUrlError("Private, loopback, and non-public image addresses are blocked.")
    return parsed, host, port, addresses[0]


def _connect_to_address(address_info: tuple[Any, ...], timeout: float) -> socket.socket:
    family, socket_type, protocol, _, address = address_info
    connection = socket.socket(family, socket_type, protocol)
    connection.settimeout(timeout)
    try:
        connection.connect(address)
    except Exception:
        connection.close()
        raise
    return connection


class _PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, host: str, port: int, address_info: tuple[Any, ...], timeout_seconds: int):
        super().__init__(host, port, timeout=timeout_seconds)
        self.address_info = address_info
        self.timeout_seconds = timeout_seconds

    def connect(self) -> None:
        self.sock = _connect_to_address(self.address_info, self.timeout_seconds)


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host: str, port: int, address_info: tuple[Any, ...], timeout_seconds: int):
        super().__init__(host, port, timeout=timeout_seconds, context=ssl.create_default_context())
        self.address_info = address_info
        self.timeout_seconds = timeout_seconds

    def connect(self) -> None:
        raw_socket = _connect_to_address(self.address_info, self.timeout_seconds)
        try:
            self.sock = self._context.wrap_socket(raw_socket, server_hostname=self.host)
        except Exception:
            raw_socket.close()
            raise


def download_candidate_image(
    value: str,
    *,
    timeout_seconds: int = DOWNLOAD_TIMEOUT_SECONDS,
    max_bytes: int = MAX_DOWNLOAD_BYTES,
) -> bytes:
    current_url = value
    deadline = time.monotonic() + timeout_seconds
    for redirect_number in range(MAX_REDIRECTS + 1):
        parsed, host, port, address_info = _resolve_public_url(current_url)
        connection_type = _PinnedHTTPSConnection if parsed.scheme.lower() == "https" else _PinnedHTTPConnection
        connection = connection_type(host, port, address_info, timeout_seconds)
        host_header = f"[{host}]" if ":" in host else host
        default_port = 443 if parsed.scheme.lower() == "https" else 80
        if port != default_port:
            host_header = f"{host_header}:{port}"
        request_path = quote(parsed.path or "/", safe="/%:@!$&'()*+,;=-._~")
        if parsed.query:
            request_path += "?" + parsed.query
        try:
            connection.request(
                "GET",
                request_path,
                headers={
                    "Host": host_header,
                    "User-Agent": "VexaLens-ImageTrace/1.0",
                    "Accept": "image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.1",
                    "Accept-Encoding": "identity",
                    "Connection": "close",
                },
            )
            response = connection.getresponse()
            if response.status in {301, 302, 303, 307, 308}:
                location = response.getheader("Location")
                response.close()
                connection.close()
                if not location or redirect_number >= MAX_REDIRECTS:
                    raise UnsafeImageUrlError("Candidate image has too many redirects.")
                current_url = urljoin(current_url, location)
                continue
            if response.status != 200:
                raise UnsafeImageUrlError(f"Candidate image returned HTTP {response.status}.")
            length = response.getheader("Content-Length")
            if length and int(length) > max_bytes:
                raise UnsafeImageUrlError(f"Candidate image exceeds the {max_bytes} byte verification limit.")
            chunks: list[bytes] = []
            total = 0
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError(f"Candidate image download exceeded the {timeout_seconds}-second limit.")
                if connection.sock is not None:
                    connection.sock.settimeout(remaining)
                chunk = response.read(64 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise UnsafeImageUrlError(f"Candidate image exceeds the {max_bytes} byte verification limit.")
                chunks.append(chunk)
            return b"".join(chunks)
        finally:
            connection.close()
    raise UnsafeImageUrlError("Candidate image has too many redirects.")


async def verify_candidates(
    results: list[dict[str, Any]],
    reference: Image.Image,
    on_update: Callable[[dict[str, Any]], Awaitable[None]] | None = None,
) -> None:
    semaphore = asyncio.Semaphore(TRACE_VERIFY_CONCURRENCY)
    results.sort(
        key=lambda result: (
            bool(result.get("social")),
            bool(result.get("verified")),
            result.get("similarity") if isinstance(result.get("similarity"), (int, float)) else -1,
        ),
        reverse=True,
    )

    async def verify(result: dict[str, Any]) -> None:
        image_url = result.get("image_url")
        if not image_url:
            result["verification_status"] = "No direct candidate image was supplied by the search engine."
            if on_update:
                await on_update(copy.deepcopy(result))
            return
        async with semaphore:
            try:
                image_bytes = await asyncio.wait_for(
                    asyncio.to_thread(
                        download_candidate_image,
                        image_url,
                        timeout_seconds=TRACE_VERIFY_TIMEOUT_SECONDS,
                        max_bytes=TRACE_VERIFY_MAX_DOWNLOAD_BYTES,
                    ),
                    timeout=TRACE_VERIFY_TIMEOUT_SECONDS,
                )
                candidate_image, _ = decode_image(image_bytes)
                score = float(phash_similarity(reference, candidate_image))
                result["similarity"] = score
                result["verified"] = bool(score >= 85)
                result["verification_status"] = "locally compared"
            except Exception as exc:
                result["verification_status"] = f"not verified: {type(exc).__name__}"
                logger.info("Image Trace candidate verification failed: %s", type(exc).__name__)
            if on_update:
                await on_update(copy.deepcopy(result))

    candidates = results[:TRACE_VERIFY_MAX_RESULTS]
    await asyncio.gather(*(verify(result) for result in candidates))
    for result in results[TRACE_VERIFY_MAX_RESULTS:]:
        result["verification_status"] = "not checked: 30-result verification limit"
        if on_update:
            await on_update(copy.deepcopy(result))
    results.sort(
        key=lambda result: (
            bool(result.get("social")),
            bool(result["verified"]),
            result["similarity"] if isinstance(result["similarity"], (int, float)) else -1,
        ),
        reverse=True,
    )


def _database_path() -> Path:
    configured = os.environ.get("VEXALENS_IMAGE_TRACE_DB", "").strip()
    path = Path(configured).expanduser() if configured else Path(__file__).resolve().parent / "data" / "image_trace.sqlite3"
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def _connect_database() -> sqlite3.Connection:
    connection = sqlite3.connect(_database_path(), timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS image_trace_cases (
            record_id INTEGER PRIMARY KEY AUTOINCREMENT,
            case_id TEXT NOT NULL,
            searched_at TEXT NOT NULL,
            sha256 TEXT NOT NULL,
            phash TEXT NOT NULL,
            engines_json TEXT NOT NULL,
            engine_status_json TEXT NOT NULL,
            results_json TEXT NOT NULL,
            notes_json TEXT NOT NULL,
            previous_hash TEXT NOT NULL,
            row_hash TEXT NOT NULL
        )
        """
    )
    existing_columns = {
        row["name"] for row in connection.execute("PRAGMA table_info(image_trace_cases)").fetchall()
    }
    if "engine_details_json" not in existing_columns:
        connection.execute(
            "ALTER TABLE image_trace_cases ADD COLUMN engine_details_json TEXT NOT NULL DEFAULT '{}'"
        )
    connection.execute(
        """
        CREATE TRIGGER IF NOT EXISTS image_trace_no_update
        BEFORE UPDATE ON image_trace_cases
        BEGIN
            SELECT RAISE(ABORT, 'Image Trace case records are append-only');
        END
        """
    )
    connection.execute(
        """
        CREATE TRIGGER IF NOT EXISTS image_trace_no_delete
        BEFORE DELETE ON image_trace_cases
        BEGIN
            SELECT RAISE(ABORT, 'Image Trace case records are append-only');
        END
        """
    )
    connection.commit()
    return connection


def _record_payload(
    record_id: int,
    case_id: str,
    searched_at: str,
    sha256: str,
    phash: str,
    engines: list[str],
    engine_status: dict[str, str],
    results: list[dict[str, Any]],
    notes: list[str],
    engine_details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload = {
        "record_id": record_id,
        "case_id": case_id,
        "searched_at": searched_at,
        "sha256": sha256,
        "phash": phash,
        "engines": engines,
        "engine_status": engine_status,
        "results": results,
        "notes": notes,
    }
    if engine_details:
        payload["engine_details"] = engine_details
    return payload


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def save_search_record(record: dict[str, Any]) -> int:
    connection = _connect_database()
    try:
        connection.execute("BEGIN IMMEDIATE")
        latest = connection.execute(
            "SELECT record_id, row_hash FROM image_trace_cases ORDER BY record_id DESC LIMIT 1"
        ).fetchone()
        record_id = int(latest["record_id"]) + 1 if latest else 1
        previous_hash = latest["row_hash"] if latest else _GENESIS_HASH
        payload = _record_payload(
            record_id,
            record["case_id"],
            record["searched_at"],
            record["sha256"],
            record["phash"],
            record["engines"],
            record["engine_status"],
            record["results"],
            record["notes"],
            record.get("engine_details"),
        )
        row_hash = hashlib.sha256((previous_hash + _canonical_json(payload)).encode("utf-8")).hexdigest()
        connection.execute(
            """
            INSERT INTO image_trace_cases (
                record_id, case_id, searched_at, sha256, phash, engines_json,
                engine_status_json, results_json, notes_json, engine_details_json,
                previous_hash, row_hash
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                record_id,
                record["case_id"],
                record["searched_at"],
                record["sha256"],
                record["phash"],
                _canonical_json(record["engines"]),
                _canonical_json(record["engine_status"]),
                _canonical_json(record["results"]),
                _canonical_json(record["notes"]),
                _canonical_json(record.get("engine_details", {})),
                previous_hash,
                row_hash,
            ),
        )
        connection.commit()
        return record_id
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def _row_to_record(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "record_id": row["record_id"],
        "case_id": row["case_id"],
        "searched_at": row["searched_at"],
        "sha256": row["sha256"],
        "phash": row["phash"],
        "engines": json.loads(row["engines_json"]),
        "engine_status": json.loads(row["engine_status_json"]),
        "results": json.loads(row["results_json"]),
        "notes": json.loads(row["notes_json"]),
        "engine_details": json.loads(row["engine_details_json"]),
        "previous_hash": row["previous_hash"],
        "row_hash": row["row_hash"],
    }


def list_search_records(limit: int = 50) -> list[dict[str, Any]]:
    with closing(_connect_database()) as connection:
        rows = connection.execute(
            "SELECT * FROM image_trace_cases ORDER BY record_id DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [_row_to_record(row) for row in rows]


def get_search_record(record_id: int) -> dict[str, Any] | None:
    with closing(_connect_database()) as connection:
        row = connection.execute(
            "SELECT * FROM image_trace_cases WHERE record_id = ?",
            (record_id,),
        ).fetchone()
    return _row_to_record(row) if row else None


def verify_search_log() -> dict[str, Any]:
    verified = 0
    expected_previous = _GENESIS_HASH
    with closing(_connect_database()) as connection:
        rows = connection.execute("SELECT * FROM image_trace_cases ORDER BY record_id").fetchall()
    for expected_id, row in enumerate(rows, start=1):
        record = _row_to_record(row)
        if record["record_id"] != expected_id or record["previous_hash"] != expected_previous:
            return {"intact": False, "records_verified": verified, "first_invalid_record_id": record["record_id"]}
        payload = _record_payload(
            record["record_id"],
            record["case_id"],
            record["searched_at"],
            record["sha256"],
            record["phash"],
            record["engines"],
            record["engine_status"],
            record["results"],
            record["notes"],
            record.get("engine_details"),
        )
        expected_hash = hashlib.sha256((expected_previous + _canonical_json(payload)).encode("utf-8")).hexdigest()
        if not hmac.compare_digest(expected_hash, record["row_hash"]):
            return {"intact": False, "records_verified": verified, "first_invalid_record_id": record["record_id"]}
        expected_previous = record["row_hash"]
        verified += 1
    return {"intact": True, "records_verified": verified, "first_invalid_record_id": None}


def render_case_report(record: dict[str, Any]) -> str:
    escape = lambda value: html.escape(str(value), quote=True)
    engine_rows = "".join(
        f"<tr><th>{escape(engine)}</th><td>{escape(status)}</td></tr>"
        for engine, status in record["engine_status"].items()
    )
    for engine, detail in record.get("engine_details", {}).items():
        if not isinstance(detail, dict):
            continue
        summary = f"{detail.get('elapsed_ms', 0)} ms"
        if detail.get("error"):
            summary += f"; {detail['error']}"
        engine_rows += f"<tr><th>{escape(engine)} timing/error</th><td>{escape(summary)}</td></tr>"
    if not engine_rows:
        engine_rows = '<tr><td colspan="2">No search engines were selected.</td></tr>'
    empty_results_message = "No results were returned; no conclusion about online presence can be drawn."
    selected_statuses = [
        record["engine_status"].get(engine)
        for engine in record.get("engines", [])
    ]
    if selected_statuses and all(status in {"failed", "not_configured"} for status in selected_statuses):
        empty_results_message = "Search could not be completed by any selected engine."
    elif any(status == "no_matches" for status in selected_statuses):
        empty_results_message = "No matches found for engines that completed successfully."
    result_rows: list[str] = []
    for result in record["results"]:
        url = normalize_result_url(result.get("url"))
        safe_link = (
            f'<a href="{escape(url)}" rel="noopener noreferrer">{escape(url)}</a>'
            if url
            else "(invalid URL)"
        )
        similarity = result.get("similarity")
        similarity_text = f"{float(similarity):.1f}%" if isinstance(similarity, (int, float)) else "n/a"
        result_rows.append(
            "<tr>"
            f"<td>{escape(result.get('platform', 'Website'))}</td>"
            f"<td>{escape(', '.join(result.get('engines', [result.get('engine', '')])))}</td>"
            f"<td>{safe_link}</td>"
            f"<td>{similarity_text}</td>"
            f"<td>{'Yes' if result.get('verified') is True else 'No'}</td>"
            "</tr>"
        )
    notes = "".join(f"<li>{escape(note)}</li>" for note in record["notes"])
    return (
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
        f"<title>Image Trace case {escape(record['case_id'])}</title>"
        "<style>body{font:15px/1.5 system-ui,sans-serif;max-width:1000px;margin:2rem auto;padding:0 1rem;color:#172033}"
        "table{border-collapse:collapse;width:100%;margin:1rem 0}th,td{text-align:left;padding:.5rem;border-bottom:1px solid #ccd3de;overflow-wrap:anywhere}"
        "th{width:180px}a{color:#075985}.muted{color:#526071}</style></head><body>"
        "<h1>Image Trace report</h1>"
        f"<p>Case ID: {escape(record['case_id'])}<br>UTC time: {escape(record['searched_at'])}</p>"
        "<h2>Evidence hashes</h2><table>"
        f"<tr><th>SHA-256</th><td><code>{escape(record['sha256'])}</code></td></tr>"
        f"<tr><th>pHash</th><td><code>{escape(record['phash'])}</code></td></tr></table>"
        "<h2>Search engines</h2><table>"
        f"{engine_rows}</table>"
        "<h2>Results</h2><table><thead><tr><th>Platform</th><th>Engine</th><th>Link</th>"
        "<th>Similarity</th><th>Verified</th></tr></thead><tbody>"
        f"{''.join(result_rows) or f'<tr><td colspan=\"5\">{escape(empty_results_message)}</td></tr>'}"
        "</tbody></table><h2>Limitations</h2><ul>"
        f"{notes}</ul><p class=\"muted\">Similarity is a local indicator, not proof of identity or source. "
        "A missing result does not prove that the image is absent from the internet.</p></body></html>"
    )


def _search_copy(image: Image.Image, target: Path) -> None:
    derivative = image.copy()
    derivative.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
    output = BytesIO()
    derivative.save(output, format="JPEG", quality=80, optimize=True)
    target.write_bytes(output.getvalue())


def search_crop_variants(image: Image.Image) -> list[Image.Image]:
    width, height = image.size
    crop_width = min(width, max(1, math.ceil(width * 0.7)))
    crop_height = min(height, max(1, math.ceil(height * 0.7)))
    right = width - crop_width
    bottom = height - crop_height
    center_x = right // 2
    center_y = bottom // 2
    boxes = (
        (0, 0, width, height),
        (center_x, center_y, center_x + crop_width, center_y + crop_height),
        (0, 0, crop_width, crop_height),
        (right, 0, width, crop_height),
        (0, bottom, crop_width, height),
        (right, bottom, width, height),
    )
    return [image.crop(box) for box in boxes]


def _resolve_case_id(case_id: str | None) -> str:
    resolved_case_id = (case_id or "").strip() or os.urandom(16).hex()
    if len(resolved_case_id) > 128 or any(ord(char) < 32 for char in resolved_case_id):
        raise ImageTraceInputError("Case ID must be 128 characters or fewer and contain no control characters.")
    return resolved_case_id


def _social_coverage(
    results: list[dict[str, Any]],
    engine_status: dict[str, str],
    known_link_counts: dict[str, tuple[int, int]] | None = None,
) -> list[str]:
    notes: list[str] = []
    for platform in SOCIAL_PLATFORMS:
        indexed_count = sum(result.get("platform") == platform for result in results)
        link_count, checked_count = (known_link_counts or {}).get(platform, (0, 0))
        engine_status[f"coverage:{platform}"] = (
            f"{indexed_count} indexed result(s); {checked_count} known-link image(s) checked "
            f"across {link_count} supplied link(s)"
        )
        if known_link_counts is None:
            notes.append(
                f"{platform}: {indexed_count} indexed result(s); known links were not scanned. "
                "Use the Known links scan to check investigator-supplied public pages."
            )
        else:
            notes.append(
                f"{platform}: {indexed_count} indexed result(s); {checked_count} image(s) checked "
                f"across {link_count} known link(s)."
            )
    return notes


def _search_cache_key(
    phash: str,
    engines: list[str],
    deep_search: bool = False,
) -> tuple[str, tuple[str, ...], bool]:
    return phash, tuple(sorted(set(engines))), deep_search


def _get_cached_search(
    phash: str,
    engines: list[str],
    deep_search: bool = False,
) -> dict[str, Any] | None:
    key = _search_cache_key(phash, engines, deep_search)
    now = time.monotonic()
    with _search_cache_lock:
        expired = [cache_key for cache_key, (expires_at, _) in _search_cache.items() if expires_at <= now]
        for cache_key in expired:
            _search_cache.pop(cache_key, None)
        cached = _search_cache.get(key)
        return copy.deepcopy(cached[1]) if cached else None


def _cache_search(
    phash: str,
    engines: list[str],
    engine_status: dict[str, str],
    results: list[dict[str, Any]],
    engine_details: dict[str, Any] | None = None,
    deep_search: bool = False,
) -> None:
    key = _search_cache_key(phash, engines, deep_search)
    cached = {
        "engine_status": dict(engine_status),
        "engine_details": copy.deepcopy(engine_details or {}),
        "results": copy.deepcopy(results),
    }
    with _search_cache_lock:
        _search_cache[key] = (time.monotonic() + SEARCH_CACHE_TTL_SECONDS, cached)


def _write_search_variants(
    image: Image.Image,
    directory: str,
    deep_search: bool = False,
) -> list[Path]:
    search_paths: list[Path] = []
    variants = search_crop_variants(image) if deep_search else [image]
    for index, variant in enumerate(variants):
        search_path = Path(directory) / f"metadata-stripped-variant-{index}.jpg"
        _search_copy(variant, search_path)
        search_paths.append(search_path)
    return search_paths


def _build_trace_record(
    image_bytes: bytes,
    phash: str,
    case_id: str | None,
    selected_engines: list[str],
    social_only: bool,
    engine_status: dict[str, str],
    engine_details: dict[str, Any],
    all_results: list[dict[str, Any]],
    cached: bool,
    deep_search: bool,
    searched_at: str,
) -> dict[str, Any]:
    resolved_case_id = _resolve_case_id(case_id)
    response_status = dict(engine_status)
    coverage_notes = _social_coverage(all_results, response_status)
    results = (
        [result for result in all_results if result.get("social")]
        if social_only
        else all_results
    )
    notes = [
        "The original upload is not stored. Search engines receive a metadata-stripped JPEG derivative only.",
        "Automated image search uses Google Cloud Vision Web Detection, Yandex Image Search API, and the official TinEye API. Bing remains available only as a manual search.",
        "The full image is searched first. Center and quadrant crops are searched only after an engine returns no matches and the user explicitly starts Deep search.",
        "Provider results are public-index observations, not proof of source, date, authorship, authenticity, or full-image identity; provider retention and use policies apply.",
        "Candidate verification is local and approximate. Similarity does not prove identity, source, authorship, date, or authenticity.",
        "Social platform coverage is limited to results exposed by the selected public indexes; private accounts, stories, and unindexed posts are not searched.",
    ]
    if cached:
        notes.append("Search results and local verification were returned from the one-hour perceptual-hash cache.")
    if social_only:
        notes.append("Social media only was selected; non-social search results were excluded from this response.")
    notes.extend(coverage_notes)
    if results and any(result.get("similarity") is None for result in results):
        notes.append("Some candidates could not be downloaded as public images, so they remain unverified.")
    selected_statuses = [response_status.get(engine, "failed") for engine in selected_engines]
    if not results and selected_statuses and all(
        status in {"failed", "not_configured"} for status in selected_statuses
    ):
        notes.append("Search could not be completed by any selected engine. Retry after checking provider configuration and connectivity; no conclusion about online presence can be drawn.")
    elif not results:
        if social_only:
            if any(status == "no_matches" for status in selected_statuses):
                notes.append("No social media matches were found by engines that completed successfully. This does not prove that the image is absent online.")
            else:
                notes.append("No social media results were returned. This does not prove that the image is absent online.")
        elif any(status == "no_matches" for status in selected_statuses):
            notes.append("No matches found for engines that completed successfully. Failed or unconfigured engines did not provide a result.")
        else:
            notes.append("No results were returned; the selected engines did not establish that the image is absent online.")

    record = {
        "case_id": resolved_case_id,
        "searched_at": searched_at,
        "sha256": hashlib.sha256(image_bytes).hexdigest(),
        "phash": phash,
        "engines": selected_engines,
        "engine_status": response_status,
        "engine_details": engine_details,
        "results": results,
        "notes": notes,
        "cache_hit": cached,
        "deep_search": deep_search,
    }
    record["record_id"] = save_search_record(record)
    return record


async def _search_with_details(
    image_paths: list[Path],
    engines: list[str],
    deep_search: bool,
) -> tuple[dict[str, str], dict[str, Any], list[dict[str, Any]]]:
    statuses: dict[str, str] = {}
    details: dict[str, Any] = {}
    collected: list[dict[str, Any]] = []
    async for engine, status, results, detail in search_engine_results_stream(
        image_paths,
        engines,
        deep_search,
    ):
        statuses[engine] = status
        details[engine] = detail
        collected.extend(results)
    return statuses, details, _deduplicate_engine_results(collected)


async def analyze_image_trace(
    image_bytes: bytes,
    case_id: str | None = None,
    engines: list[str] | None = None,
    social_only: bool = False,
    force_refresh: bool = False,
    deep_search: bool = False,
) -> dict[str, Any]:
    image, _ = decode_image(image_bytes)
    phash = str(imagehash.phash(image, hash_size=8))
    selected_engines = engines or list(SUPPORTED_ENGINES)
    cached_search = None if force_refresh else _get_cached_search(phash, selected_engines, deep_search)
    searched_at = datetime.now(timezone.utc).isoformat()

    if cached_search:
        engine_status = cached_search["engine_status"]
        engine_details = cached_search.get("engine_details", {})
        all_results = cached_search["results"]
    else:
        with tempfile.TemporaryDirectory(prefix="vexalens_image_trace_") as temporary_directory:
            search_paths = _write_search_variants(image, temporary_directory, deep_search)
            engine_status, engine_details, all_results = await _search_with_details(
                search_paths,
                selected_engines,
                deep_search,
            )
        await verify_candidates(all_results, image)
        _cache_search(phash, selected_engines, engine_status, all_results, engine_details, deep_search)

    return _build_trace_record(
        image_bytes,
        phash,
        case_id,
        selected_engines,
        social_only,
        engine_status,
        engine_details,
        all_results,
        cached_search is not None,
        deep_search,
        searched_at,
    )


async def stream_image_trace(
    image_bytes: bytes,
    case_id: str | None = None,
    engines: list[str] | None = None,
    social_only: bool = False,
    force_refresh: bool = False,
    deep_search: bool = False,
):
    image, _ = decode_image(image_bytes)
    phash = str(imagehash.phash(image, hash_size=8))
    selected_engines = engines or list(SUPPORTED_ENGINES)
    searched_at = datetime.now(timezone.utc).isoformat()
    cached_search = None if force_refresh else _get_cached_search(phash, selected_engines, deep_search)
    yield {
        "type": "start",
        "searched_at": searched_at,
        "engine_status": {engine: "searching" for engine in selected_engines},
        "cache_hit": cached_search is not None,
    }

    if cached_search:
        engine_status = cached_search["engine_status"]
        engine_details = cached_search.get("engine_details", {})
        all_results = cached_search["results"]
        for engine in selected_engines:
            yield {
                "type": "engine",
                "engine": engine,
                "status": engine_status.get(engine, "failed"),
                "detail": engine_details.get(engine, {}),
                "results": [result for result in all_results if engine in result.get("engines", [result.get("engine")])],
                "cached": True,
            }
    else:
        engine_status: dict[str, str] = {}
        engine_details: dict[str, Any] = {}
        collected: list[dict[str, Any]] = []
        with tempfile.TemporaryDirectory(prefix="vexalens_image_trace_") as temporary_directory:
            search_paths = _write_search_variants(image, temporary_directory, deep_search)
            async for engine, status, engine_results, detail in search_engine_results_stream(
                search_paths,
                selected_engines,
                deep_search,
            ):
                engine_status[engine] = status
                engine_details[engine] = detail
                collected.extend(engine_results)
                yield {
                    "type": "engine",
                    "engine": engine,
                    "status": status,
                    "detail": detail,
                    "results": engine_results,
                }
            all_results = _deduplicate_engine_results(collected)

        updates: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()

        async def send_update(result: dict[str, Any]) -> None:
            await updates.put(result)

        async def verify_and_finish() -> None:
            await verify_candidates(all_results, image, send_update)
            await updates.put(None)

        verify_task = asyncio.create_task(verify_and_finish())
        try:
            while True:
                update = await updates.get()
                if update is None:
                    break
                yield {"type": "verification", "result": update}
            await verify_task
        finally:
            if not verify_task.done():
                verify_task.cancel()
                await asyncio.gather(verify_task, return_exceptions=True)
        _cache_search(phash, selected_engines, engine_status, all_results, engine_details, deep_search)

    record = _build_trace_record(
        image_bytes,
        phash,
        case_id,
        selected_engines,
        social_only,
        engine_status,
        engine_details,
        all_results,
        cached_search is not None,
        deep_search,
        searched_at,
    )
    yield {"type": "complete", "record": record}


_GALLERY_DL_NETWORK_GUARD = """
import ipaddress
import socket

_original_getaddrinfo = socket.getaddrinfo

def _public_getaddrinfo(host, port, *args, **kwargs):
    results = _original_getaddrinfo(host, port, *args, **kwargs)
    if not results:
        raise OSError("DNS returned no addresses")
    for result in results:
        try:
            address = ipaddress.ip_address(result[4][0].split("%", 1)[0])
        except (IndexError, ValueError) as exc:
            raise OSError("DNS returned an invalid address") from exc
        if not address.is_global:
            raise OSError("Blocked non-public network address")
    return results

socket.getaddrinfo = _public_getaddrinfo
"""


def _scan_error_status(detail: str) -> str:
    cleaned = " ".join(detail.split())
    if re.search(r"\b(login|log in|sign in|authentication|unauthorized|401|403)\b", cleaned, re.IGNORECASE):
        return "login required or access restricted"
    cleaned = re.sub(r"https?://\S+", "[URL]", cleaned)[:180]
    return f"error: {cleaned}" if cleaned else "error: gallery-dl could not read this page"


def extract_public_image_urls(page_url: str) -> tuple[list[str], str]:
    normalized_page_url = normalize_result_url(page_url)
    if not normalized_page_url or _is_search_engine_results_page(normalized_page_url):
        return [], "error: provide a public HTTP(S) post or profile URL"
    try:
        _resolve_public_url(normalized_page_url)
    except UnsafeImageUrlError as exc:
        return [], f"error: blocked unsafe page URL ({exc})"
    except OSError as exc:
        return [], _scan_error_status(str(exc))

    with tempfile.TemporaryDirectory(prefix="vexalens_gallery_dl_") as temporary_directory:
        isolated_dir = Path(temporary_directory)
        (isolated_dir / "sitecustomize.py").write_text(_GALLERY_DL_NETWORK_GUARD, encoding="utf-8")
        environment = {
            key: value
            for key, value in os.environ.items()
            if key.lower() not in {
                "all_proxy",
                "http_proxy",
                "https_proxy",
                "no_proxy",
                "netrc",
                "gallery_dl_config",
            }
        }
        environment.update(
            {
                "APPDATA": temporary_directory,
                "HOME": temporary_directory,
                "USERPROFILE": temporary_directory,
                "XDG_CACHE_HOME": temporary_directory,
                "XDG_CONFIG_HOME": temporary_directory,
                "XDG_DATA_HOME": temporary_directory,
                "PYTHONPATH": temporary_directory,
            }
        )
        command = [
            sys.executable,
            "-m",
            "gallery_dl",
            "--warning",
            "--no-colors",
            "--config-ignore",
            "--no-netrc",
            "--http-timeout",
            str(DOWNLOAD_TIMEOUT_SECONDS),
            "--retries",
            "0",
            "--range",
            f"1-{MAX_IMAGES_PER_KNOWN_LINK}",
            "--post-range",
            f"1-{MAX_IMAGES_PER_KNOWN_LINK}",
            "--child-range",
            f"1-{MAX_IMAGES_PER_KNOWN_LINK}",
            "--resolve-urls",
            normalized_page_url,
        ]
        try:
            completed = subprocess.run(
                command,
                cwd=temporary_directory,
                env=environment,
                stdin=subprocess.DEVNULL,
                capture_output=True,
                check=False,
                text=True,
                errors="replace",
                timeout=GALLERY_DL_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired:
            return [], f"error: page extraction timed out after {GALLERY_DL_TIMEOUT_SECONDS} seconds"
        except OSError as exc:
            return [], _scan_error_status(f"{type(exc).__name__}: {exc}")

    image_urls: list[str] = []
    seen: set[str] = set()
    for line in completed.stdout.splitlines():
        candidate = normalize_result_url(line.strip())
        if candidate and candidate not in seen:
            image_urls.append(candidate)
            seen.add(candidate)
        if len(image_urls) >= MAX_IMAGES_PER_KNOWN_LINK:
            break
    if completed.returncode:
        status = _scan_error_status(completed.stderr or f"gallery-dl exited with status {completed.returncode}")
        return image_urls, status
    if not image_urls:
        return [], "no public images found (or this page is unsupported)"
    return image_urls, f"ok: {len(image_urls)} public image URL(s) found"


async def scan_known_links(
    image_bytes: bytes,
    urls: list[str],
    authorization_note: str,
    case_id: str | None = None,
) -> dict[str, Any]:
    reference, _ = decode_image(image_bytes)
    sha256 = hashlib.sha256(image_bytes).hexdigest()
    phash = str(imagehash.phash(reference, hash_size=8))
    resolved_case_id = _resolve_case_id(case_id)
    if not authorization_note.strip() or len(authorization_note) > 500:
        raise ImageTraceInputError("Provide an authorization note of 1 to 500 characters.")
    if not urls or len(urls) > MAX_KNOWN_LINKS:
        raise ImageTraceInputError(f"Provide between 1 and {MAX_KNOWN_LINKS} public URLs.")

    image_semaphore = asyncio.Semaphore(8)
    page_semaphore = asyncio.Semaphore(4)

    async def check_image(
        page_url: str,
        platform: str,
        image_url: str,
    ) -> tuple[dict[str, Any] | None, bool, str | None]:
        async with image_semaphore:
            try:
                image_bytes = await asyncio.wait_for(
                    asyncio.to_thread(download_candidate_image, image_url),
                    timeout=DOWNLOAD_TIMEOUT_SECONDS + 1,
                )
                candidate, _ = decode_image(image_bytes)
                phash_score = _hash_similarity(
                    imagehash.phash(reference, hash_size=8),
                    imagehash.phash(candidate, hash_size=8),
                )
                dhash_score = _hash_similarity(
                    imagehash.dhash(reference, hash_size=8),
                    imagehash.dhash(candidate, hash_size=8),
                )
                orb_score = await asyncio.to_thread(orb_similarity, reference, candidate)
                score = max(phash_score, dhash_score)
                if score < 75:
                    return None, True, None
                return (
                    {
                        "engine": "known_links",
                        "engines": ["known_links"],
                        "url": page_url,
                        "post_url": page_url,
                        "image_url": image_url,
                        "platform": platform,
                        "social": is_social_platform(platform),
                        "similarity": score,
                        "phash_similarity": phash_score,
                        "dhash_similarity": dhash_score,
                        "orb_similarity": orb_score,
                        "verified": bool(score >= 85),
                        "verification_status": "locally compared",
                    },
                    True,
                    None,
                )
            except Exception as exc:
                logger.info("Known-links image verification failed: %s", type(exc).__name__)
                return None, False, type(exc).__name__

    async def scan_url(index: int, page_url: str) -> dict[str, Any]:
        platform = platform_from_url(page_url)
        async with page_semaphore:
            try:
                image_urls, status = await asyncio.wait_for(
                    asyncio.to_thread(extract_public_image_urls, page_url),
                    timeout=GALLERY_DL_TIMEOUT_SECONDS + 2,
                )
            except asyncio.TimeoutError:
                return {
                    "index": index,
                    "url": page_url,
                    "platform": platform,
                    "status": f"error: page extraction timed out after {GALLERY_DL_TIMEOUT_SECONDS} seconds",
                    "checked": 0,
                    "results": [],
                }
            except Exception as exc:
                logger.info("Known-links page extraction failed: %s", type(exc).__name__)
                return {
                    "index": index,
                    "url": page_url,
                    "platform": platform,
                    "status": _scan_error_status(f"{type(exc).__name__}: {exc}"),
                    "checked": 0,
                    "results": [],
                }
            checks = await asyncio.gather(
                *(check_image(page_url, platform, image_url) for image_url in image_urls),
                return_exceptions=True,
            )
        matches: list[dict[str, Any]] = []
        checked = 0
        failures: dict[str, int] = {}
        for check in checks:
            if isinstance(check, BaseException):
                failures[type(check).__name__] = failures.get(type(check).__name__, 0) + 1
                continue
            result, inspected, error = check
            checked += int(inspected)
            if error:
                failures[error] = failures.get(error, 0) + 1
            if result is not None:
                matches.append(result)
        failure_summary = (
            "; image download/decoding failures: "
            + ", ".join(f"{name}={count}" for name, count in sorted(failures.items()))
            if failures
            else ""
        )
        return {
            "index": index,
            "url": page_url,
            "platform": platform,
            "status": f"{status}; {checked} image(s) checked; {len(matches)} match(es){failure_summary}",
            "checked": checked,
            "results": matches,
        }

    page_results = await asyncio.gather(
        *(scan_url(index, url) for index, url in enumerate(urls, start=1))
    )
    results: list[dict[str, Any]] = []
    seen_matches: set[tuple[str, str]] = set()
    for page_result in page_results:
        for result in page_result["results"]:
            key = (result["url"], result["image_url"])
            if key not in seen_matches:
                seen_matches.add(key)
                results.append(result)
    results.sort(
        key=lambda result: (
            bool(result["social"]),
            bool(result["verified"]),
            result["similarity"],
        ),
        reverse=True,
    )

    per_platform: dict[str, tuple[int, int]] = {}
    for platform in SOCIAL_PLATFORMS:
        links = [item for item in page_results if item["platform"] == platform]
        per_platform[platform] = (len(links), sum(item["checked"] for item in links))
    engine_status = {
        f"known_link_{item['index']}": item["status"]
        for item in page_results
    }
    aggregate_statuses = [item["status"] for item in page_results]
    if any(status.startswith("ok:") for status in aggregate_statuses):
        engine_status["gallery-dl"] = "ok"
    elif any("login required" in status for status in aggregate_statuses):
        engine_status["gallery-dl"] = "login required or access restricted"
    else:
        engine_status["gallery-dl"] = "no public images found or all pages were unavailable"
    coverage_notes = _social_coverage(results=[], engine_status=engine_status, known_link_counts=per_platform)
    searched_at = datetime.now(timezone.utc).isoformat()
    notes = [
        f"Authorization note: {authorization_note.strip()}",
        f"Known-links scan completed at {searched_at} (UTC).",
        *(f"URL scanned: {item['url']} - {item['status']}" for item in page_results),
        "Only public pages were inspected. No cookies, browser profiles, logins, CAPTCHAs, or rate limits were bypassed.",
        "Reported similarity is the maximum of the pHash and dHash scores. ORB feature matching is included as a separate crop/edit clue.",
        "A missing result means no qualifying image was found on the supplied pages, not that the image is absent elsewhere.",
        *coverage_notes,
    ]
    if not results:
        notes.append("No images with a pHash/dHash similarity of 75 or higher were found on the supplied public links.")
    record = {
        "case_id": resolved_case_id,
        "searched_at": searched_at,
        "sha256": sha256,
        "phash": phash,
        "engines": ["known_links"],
        "engine_status": engine_status,
        "results": results,
        "notes": notes,
        "scanned_urls": [item["url"] for item in page_results],
    }
    record["record_id"] = save_search_record(record)
    return record
