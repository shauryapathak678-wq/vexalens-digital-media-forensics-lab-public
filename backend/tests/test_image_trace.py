import asyncio
import hashlib
import json
import os
import socket
import subprocess
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

from backend import image_trace
from backend import image_trace_providers
from backend.main import app


@pytest.fixture(autouse=True)
def clear_image_trace_cache():
    with image_trace._search_cache_lock:
        image_trace._search_cache.clear()
    yield
    with image_trace._search_cache_lock:
        image_trace._search_cache.clear()


def image_bytes(image: Image.Image, format_name: str = "PNG") -> bytes:
    from io import BytesIO

    output = BytesIO()
    image.save(output, format=format_name)
    return output.getvalue()


def make_evidence_image() -> Image.Image:
    image = Image.new("RGB", (256, 256), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((18, 18, 112, 112), fill=(20, 50, 210))
    draw.ellipse((145, 30, 223, 108), fill=(200, 190, 25))
    draw.line((24, 220, 230, 140), fill=(230, 230, 230), width=9)
    draw.text((88, 186), "VEXA", fill=(20, 170, 50))
    return image


def test_platform_detection_covers_expected_services() -> None:
    examples = {
        "https://www.instagram.com/p/example": "Instagram",
        "https://m.facebook.com/photo": "Facebook",
        "https://x.com/user/status/1": "X / Twitter",
        "https://www.tiktok.com/@user/video/1": "TikTok",
        "https://youtu.be/example": "YouTube",
        "https://redd.it/example": "Reddit",
        "https://www.pinterest.co.uk/pin/1": "Pinterest",
        "https://blog.example.wordpress.com/post": "WordPress / Blogger",
        "https://news.example.test/photo": "Website",
    }

    for url, expected in examples.items():
        assert image_trace.platform_from_url(url) == expected


def test_google_vision_results_preserve_web_detection_categories() -> None:
    payload = {
        "responses": [{
            "webDetection": {
                "pagesWithMatchingImages": [
                    {
                        "url": "https://www.google.com/search?q=not-a-source",
                        "fullMatchingImages": [{"url": "https://img.example.test/filtered.jpg"}],
                    },
                    {
                        "url": "https://www.instagram.com/p/example",
                        "pageTitle": "Public post",
                        "fullMatchingImages": [{"url": "https://img.example.test/page-match.jpg"}],
                        "partialMatchingImages": [{"url": "https://img.example.test/page-partial.jpg"}],
                    },
                ],
                "fullMatchingImages": [{"url": "https://img.example.test/full.jpg"}],
                "partialMatchingImages": [{"url": "https://img.example.test/partial.jpg"}],
            },
        }],
    }

    results = image_trace._normalize_engine_items("google_vision", payload)

    assert [result["category"] for result in results] == [
        "pagesWithMatchingImages",
        "fullMatchingImages",
        "partialMatchingImages",
    ]
    assert results[0]["url"] == "https://www.instagram.com/p/example"
    assert results[0]["image_url"] == "https://img.example.test/page-match.jpg"
    assert results[0]["matching_images"] == [
        "https://img.example.test/page-match.jpg",
        "https://img.example.test/page-partial.jpg",
    ]
    assert results[0]["social"] is True


def test_url_normalization_removes_tracking_and_rejects_non_public_hosts() -> None:
    normalized = image_trace.normalize_result_url(
        "HTTPS://WWW.Instagram.com/p/AbC/?utm_source=feed&z=2&fbclid=track#a"
    )

    assert normalized == "https://www.instagram.com/p/AbC/?z=2"
    assert image_trace.normalize_result_url("javascript:alert(1)") is None
    assert image_trace.normalize_result_url("http://127.0.0.1/private") is None
    assert image_trace.normalize_result_url("https://user:pass@example.com/image.jpg") is None


def test_engines_stream_independently_and_deduplicate_results(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []
    image_path = tmp_path / "full.jpg"
    image_path.write_bytes(b"full-image")
    monkeypatch.setattr(image_trace, "missing_provider_settings", lambda _engine: [])

    async def fake_request(engine: str, _image: bytes, _timeout: float):
        calls.append(engine)
        if engine == "tineye":
            raise image_trace_providers.ProviderRequestError("HTTP 503.", "http_error", 2, 503)
        if engine == "google_vision":
            payload = {"responses": [{"webDetection": {"pagesWithMatchingImages": [{
                "url": "https://instagram.com/p/abc/?utm_source=search",
                "pageTitle": "Public post",
            }]}}]}
        else:
            payload = {"images": [{"pageUrl": "https://instagram.com/p/abc/?fbclid=tracker"}]}
        return image_trace_providers.ProviderResponse(payload, elapsed_ms=4, attempts=1)

    monkeypatch.setattr(image_trace, "request_provider", fake_request)

    async def collect():
        return [
            event
            async for event in image_trace.search_engine_results_stream(
                image_path,
                ["google_vision", "yandex", "tineye"],
            )
        ]

    events = asyncio.run(collect())
    statuses = {engine: status for engine, status, _results, _detail in events}
    results = image_trace._deduplicate_engine_results([
        result
        for _engine, _status, engine_results, _detail in events
        for result in engine_results
    ])

    assert statuses == {
        "google_vision": "matches_found",
        "yandex": "matches_found",
        "tineye": "failed",
    }
    assert set(calls) == {"google_vision", "yandex", "tineye"}
    assert len(results) == 1
    assert results[0]["url"] == "https://instagram.com/p/abc/"
    assert results[0]["engines"] == ["google_vision", "yandex"]


def test_search_results_streams_as_each_official_provider_finishes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    image_path = tmp_path / "sample.jpg"
    image_path.write_bytes(b"sample")
    monkeypatch.setattr(image_trace, "missing_provider_settings", lambda _engine: [])

    async def fake_request(engine: str, _image: bytes, _timeout: float):
        if engine == "tineye":
            await asyncio.sleep(0.05)
            payload = {"code": 200, "results": {"matches": []}}
        else:
            await asyncio.sleep(0.001)
            payload = {"images": []}
        return image_trace_providers.ProviderResponse(payload, elapsed_ms=1, attempts=1)

    monkeypatch.setattr(image_trace, "request_provider", fake_request)

    async def collect():
        return [
            event
            async for event in image_trace.search_engine_results_stream(
                image_path,
                ["tineye", "yandex"],
            )
        ]

    events = asyncio.run(collect())

    assert [event[0] for event in events] == ["yandex", "tineye"]
    assert [event[1] for event in events] == ["no_matches", "no_matches"]


def test_deep_search_uses_crops_only_after_full_image_has_no_matches(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    full_path = tmp_path / "full.jpg"
    crop_path = tmp_path / "crop.jpg"
    full_path.write_bytes(b"full")
    crop_path.write_bytes(b"crop")
    calls: list[bytes] = []
    monkeypatch.setattr(image_trace, "missing_provider_settings", lambda _engine: [])

    async def fake_request(_engine: str, image: bytes, _timeout: float):
        calls.append(image)
        images = [] if image == b"full" else [{
            "pageUrl": "https://example.test/crop-match",
            "url": "https://images.example.test/crop.jpg",
        }]
        return image_trace_providers.ProviderResponse({"images": images}, 2, 1)

    monkeypatch.setattr(image_trace, "request_provider", fake_request)

    async def collect():
        return [
            event
            async for event in image_trace.search_engine_results_stream(
                [full_path, crop_path],
                ["yandex"],
                deep_search=True,
            )
        ]

    events = asyncio.run(collect())

    assert calls == [b"full", b"crop"]
    assert events[0][1] == "matches_found"
    assert events[0][2][0]["url"] == "https://example.test/crop-match"
    assert events[0][3]["variants_searched"] == 2


def test_deep_search_skips_crops_when_full_image_has_matches(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    full_path = tmp_path / "full.jpg"
    crop_path = tmp_path / "crop.jpg"
    full_path.write_bytes(b"full")
    crop_path.write_bytes(b"crop")
    calls: list[bytes] = []
    monkeypatch.setattr(image_trace, "missing_provider_settings", lambda _engine: [])

    async def fake_request(_engine: str, image: bytes, _timeout: float):
        calls.append(image)
        return image_trace_providers.ProviderResponse(
            {"images": [{"pageUrl": "https://example.test/full-match"}]},
            1,
            1,
        )

    monkeypatch.setattr(image_trace, "request_provider", fake_request)

    async def collect():
        return [
            event
            async for event in image_trace.search_engine_results_stream(
                [full_path, crop_path],
                ["yandex"],
                deep_search=True,
            )
        ]

    event = asyncio.run(collect())[0]

    assert calls == [b"full"]
    assert event[1] == "matches_found"
    assert event[3]["variants_searched"] == 1


def test_missing_provider_configuration_returns_not_configured(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    image_path = tmp_path / "full.jpg"
    image_path.write_bytes(b"full")
    monkeypatch.setattr(
        image_trace,
        "missing_provider_settings",
        lambda engine: ["GOOGLE_CLOUD_VISION_API_KEY"] if engine == "google_vision" else [],
    )

    async def collect():
        return [
            event
            async for event in image_trace.search_engine_results_stream(image_path, ["google_vision"])
        ]

    event = asyncio.run(collect())[0]

    assert event[1] == "not_configured"
    assert event[3]["elapsed_ms"] == 0
    assert "GOOGLE_CLOUD_VISION_API_KEY" in event[3]["error"]


def test_search_crop_variants_cover_full_image_center_and_quadrants() -> None:
    image = Image.new("RGB", (101, 101), "white")

    variants = image_trace.search_crop_variants(image)

    assert len(variants) == 6
    assert variants[0].size == image.size
    assert all((variant.width * variant.height) / (image.width * image.height) >= 0.4 for variant in variants[1:])


def test_resize_and_jpeg_recompression_keep_similarity_above_90() -> None:
    original = make_evidence_image()
    resized = original.resize((128, 128), Image.Resampling.LANCZOS)
    from io import BytesIO

    compressed_bytes = BytesIO()
    resized.save(compressed_bytes, format="JPEG", quality=60)
    compressed = Image.open(BytesIO(compressed_bytes.getvalue())).convert("RGB")

    assert image_trace.compare_images(original, compressed) >= 90


def test_unrelated_images_remain_below_70_similarity() -> None:
    first = make_evidence_image()
    noise = np.random.default_rng(42).integers(0, 256, (256, 256, 3), dtype=np.uint8)
    unrelated = Image.fromarray(noise, mode="RGB")

    assert image_trace.compare_images(first, unrelated) < 70


def test_downloadable_candidate_is_locally_scored_and_verified(monkeypatch: pytest.MonkeyPatch) -> None:
    reference = make_evidence_image()
    candidate = reference.resize((128, 128), Image.Resampling.LANCZOS)
    candidate_bytes = image_bytes(candidate, "JPEG")
    monkeypatch.setattr(
        image_trace,
        "download_candidate_image",
        lambda _url, **_kwargs: candidate_bytes,
    )
    results = [
        {
            "image_url": "https://images.example.test/copy.jpg",
            "similarity": None,
            "verified": False,
        },
        {
            "image_url": None,
            "similarity": None,
            "verified": False,
        },
    ]

    asyncio.run(image_trace.verify_candidates(results, reference))

    assert results[0]["similarity"] >= 85
    assert results[0]["verified"] is True
    assert results[0]["verification_status"] == "locally compared"
    assert results[1]["similarity"] is None
    assert results[1]["verified"] is False


def test_candidate_verification_uses_limits_and_checks_only_first_30(monkeypatch: pytest.MonkeyPatch) -> None:
    reference = make_evidence_image()
    candidate_bytes = image_bytes(reference.resize((128, 128), Image.Resampling.LANCZOS), "JPEG")
    calls: list[dict[str, int]] = []

    def fake_download(_url: str, *, timeout_seconds: int, max_bytes: int) -> bytes:
        calls.append({"timeout_seconds": timeout_seconds, "max_bytes": max_bytes})
        return candidate_bytes

    monkeypatch.setattr(image_trace, "download_candidate_image", fake_download)
    results = [
        {
            "url": f"https://example.test/page/{index}",
            "image_url": f"https://images.example.test/copy/{index}.jpg",
            "platform": "Website",
            "social": False,
            "similarity": None,
            "verified": False,
        }
        for index in range(32)
    ]

    asyncio.run(image_trace.verify_candidates(results, reference))

    assert len(calls) == 30
    assert all(call == {"timeout_seconds": 5, "max_bytes": 3 * 1024 * 1024} for call in calls)
    assert results[30]["verification_status"] == "not checked: 30-result verification limit"


def test_search_cache_hits_for_one_hour_and_force_refreshes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("VEXALENS_IMAGE_TRACE_DB", str(tmp_path / "cache.sqlite3"))
    calls = 0

    async def fake_search(_paths: list[Path], engines: list[str], _deep_search: bool):
        nonlocal calls
        calls += 1
        statuses = {engine: "no_matches" for engine in engines}
        details = {engine: {"status": "no_matches", "elapsed_ms": 5, "error": None} for engine in engines}
        return statuses, details, []

    monkeypatch.setattr(image_trace, "_search_with_details", fake_search)
    payload = image_bytes(make_evidence_image())

    async def run():
        first = await image_trace.analyze_image_trace(payload, engines=["yandex"])
        cached = await image_trace.analyze_image_trace(payload, engines=["yandex"])
        fresh = await image_trace.analyze_image_trace(payload, engines=["yandex"], force_refresh=True)
        return first, cached, fresh

    first, cached, fresh = asyncio.run(run())

    assert calls == 2
    assert first["cache_hit"] is False
    assert cached["cache_hit"] is True
    assert fresh["cache_hit"] is False


def test_search_cache_does_not_store_partial_failures() -> None:
    engines = ["google_vision", "yandex", "tineye"]
    statuses = {"google_vision": "failed", "yandex": "no_matches", "tineye": "not_configured"}

    image_trace._cache_search("a" * 16, engines, statuses, [])

    assert image_trace._get_cached_search("a" * 16, engines) is None


def test_search_cache_discards_older_partial_failures() -> None:
    phash = "a" * 16
    engines = ["google_vision", "yandex"]
    key = image_trace._search_cache_key(phash, engines)
    image_trace._search_cache[key] = (
        image_trace.time.monotonic() + image_trace.SEARCH_CACHE_TTL_SECONDS,
        {
            "engine_status": {"google_vision": "failed", "yandex": "no_matches"},
            "engine_details": {},
            "results": [],
        },
    )

    assert image_trace._get_cached_search(phash, engines) is None
    assert key not in image_trace._search_cache


def test_search_cache_expires_at_one_hour(monkeypatch: pytest.MonkeyPatch) -> None:
    now = 100.0
    monkeypatch.setattr(image_trace.time, "monotonic", lambda: now)
    image_trace._cache_search("a" * 16, ["yandex"], {"yandex": "no_matches"}, [])

    now += image_trace.SEARCH_CACHE_TTL_SECONDS - 1
    assert image_trace._get_cached_search("a" * 16, ["yandex"]) is not None
    now += 1
    assert image_trace._get_cached_search("a" * 16, ["yandex"]) is None


def test_trace_stream_emits_engine_results_and_completion(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("VEXALENS_IMAGE_TRACE_DB", str(tmp_path / "stream.sqlite3"))
    result = {
        "engine": "yandex",
        "engines": ["yandex"],
        "url": "https://news.example.test/photo",
        "image_url": None,
        "platform": "Website",
        "social": False,
        "similarity": None,
        "verified": False,
    }

    async def fake_stream(_paths: list[Path], _engines: list[str], _deep_search: bool):
        yield "yandex", "matches_found", [result], {
            "status": "matches_found",
            "elapsed_ms": 7,
            "error": None,
            "attempts": 1,
        }

    monkeypatch.setattr(image_trace, "search_engine_results_stream", fake_stream)
    response = TestClient(app).post(
        "/api/trace/stream",
        files={"image": ("evidence.png", image_bytes(make_evidence_image()), "image/png")},
        data={"engines": "yandex", "force_refresh": "true"},
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    events = [
        json.loads(block.removeprefix("data:"))
        for block in response.text.strip().split("\n\n")
    ]
    assert [event["type"] for event in events] == ["start", "engine", "verification", "complete"]
    assert events[1]["results"][0]["url"] == result["url"]
    assert events[-1]["record"]["results"][0]["url"] == result["url"]


def test_social_results_are_ranked_before_verified_website_results() -> None:
    results = [
        {"platform": "Website", "social": False, "verified": True, "similarity": 99.0, "image_url": None},
        {"platform": "Instagram", "social": True, "verified": False, "similarity": None, "image_url": None},
    ]

    asyncio.run(image_trace.verify_candidates(results, make_evidence_image()))

    assert [result["platform"] for result in results] == ["Instagram", "Website"]


def test_private_candidate_addresses_are_blocked(monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(image_trace.UnsafeImageUrlError, match="Private"):
        image_trace._resolve_public_url("http://127.0.0.1/image.png")

    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 80)),
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.1", 80)),
        ],
    )
    with pytest.raises(image_trace.UnsafeImageUrlError, match="non-public"):
        image_trace._resolve_public_url("http://rebind.example.test/image.png")

    with pytest.raises(image_trace.UnsafeImageUrlError, match="Invalid"):
        image_trace._resolve_public_url("file:///C:/Windows/win.ini")


def test_hash_chain_detects_record_tampering(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    database = tmp_path / "trace.sqlite3"
    monkeypatch.setenv("VEXALENS_IMAGE_TRACE_DB", str(database))
    base_record = {
        "case_id": "case-17",
        "searched_at": "2026-01-01T00:00:00+00:00",
        "sha256": "a" * 64,
        "phash": "b" * 16,
        "engines": ["google_vision"],
        "engine_status": {"google_vision": "matches_found"},
        "results": [],
        "notes": [],
    }

    assert image_trace.save_search_record(base_record) == 1
    second = {**base_record, "case_id": "case-18"}
    assert image_trace.save_search_record(second) == 2
    assert image_trace.verify_search_log()["intact"] is True

    connection = image_trace._connect_database()
    try:
        connection.execute("DROP TRIGGER image_trace_no_update")
        connection.execute("UPDATE image_trace_cases SET sha256 = ? WHERE record_id = 1", ("c" * 64,))
        connection.commit()
    finally:
        connection.close()

    verification = image_trace.verify_search_log()
    assert verification["intact"] is False
    assert verification["first_invalid_record_id"] == 1


def test_endpoint_returns_hashes_when_all_search_engines_fail(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    image = make_evidence_image()
    payload = image_bytes(image)
    database = tmp_path / "endpoint.sqlite3"
    monkeypatch.setenv("VEXALENS_IMAGE_TRACE_DB", str(database))
    search_calls = 0

    async def offline_search(_paths: list[Path], engines: list[str], _deep_search: bool):
        nonlocal search_calls
        search_calls += 1
        return (
            {engine: "failed" for engine in engines},
            {
                engine: {
                    "status": "failed",
                    "elapsed_ms": 3,
                    "attempts": 2,
                    "error": "Provider offline.",
                }
                for engine in engines
            },
            [],
        )

    monkeypatch.setattr(image_trace, "_search_with_details", offline_search)
    client = TestClient(app)
    response = client.post(
        "/api/trace",
        files={"image": ("evidence.png", payload, "image/png")},
        data={"case_id": "<case-22>"},
    )
    repeat = client.post(
        "/api/trace",
        files={"image": ("evidence.png", payload, "image/png")},
        data={"case_id": "<case-22>"},
    )

    assert response.status_code == 200
    result = response.json()
    repeated_result = repeat.json()
    assert search_calls == 2
    assert result["cache_hit"] is False
    assert repeated_result["cache_hit"] is False
    assert result["sha256"] == hashlib.sha256(payload).hexdigest()
    assert len(result["phash"]) == 16
    assert repeated_result["sha256"] == result["sha256"]
    assert repeated_result["phash"] == result["phash"]
    assert all(result["engine_status"][engine] == "failed" for engine in ("google_vision", "yandex", "tineye"))
    assert result["engine_details"]["google_vision"]["elapsed_ms"] == 3
    assert "Search could not be completed" in " ".join(result["notes"])
    assert result["engine_status"]["coverage:Instagram"].startswith("0 indexed result(s)")
    assert result["results"] == []
    assert result["record_id"] == 1
    assert repeated_result["record_id"] == 2
    assert image_trace.verify_search_log()["intact"] is True

    cases = client.get("/api/cases")
    record = client.get(f"/api/cases/{result['record_id']}")
    report = client.get(f"/api/cases/{result['record_id']}/report")
    verification = client.get("/api/verify-log")
    assert cases.status_code == 200 and len(cases.json()["cases"]) == 2
    assert record.status_code == 200
    assert verification.json()["intact"] is True
    assert verification.json()["records_verified"] == 2
    assert report.status_code == 200
    assert "&lt;case-22&gt;" in report.text
    assert "<case-22>" not in report.text


def test_trace_social_only_filters_full_image_results(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("VEXALENS_IMAGE_TRACE_DB", str(tmp_path / "social-only.sqlite3"))

    async def fake_search(paths: list[Path], engines: list[str], _deep_search: bool):
        assert len(paths) == 1
        assert engines == ["yandex"]
        return {"yandex": "matches_found"}, {
            "yandex": {"status": "matches_found", "elapsed_ms": 2, "error": None}
        }, [
            {
                "engine": "yandex",
                "engines": ["yandex"],
                "url": "https://instagram.com/p/public-post",
                "image_url": None,
                "platform": "Instagram",
                "social": True,
                "similarity": None,
                "verified": False,
            },
            {
                "engine": "yandex",
                "engines": ["yandex"],
                "url": "https://news.example.test/photo",
                "image_url": None,
                "platform": "Website",
                "social": False,
                "similarity": None,
                "verified": False,
            },
        ]

    monkeypatch.setattr(image_trace, "_search_with_details", fake_search)
    response = TestClient(app).post(
        "/api/trace",
        files={"image": ("evidence.png", image_bytes(make_evidence_image()), "image/png")},
        data={"engines": "yandex", "social_only": "true"},
    )

    assert response.status_code == 200
    result = response.json()
    assert [item["platform"] for item in result["results"]] == ["Instagram"]
    assert result["results"][0]["social"] is True
    assert result["engine_details"]["yandex"]["elapsed_ms"] == 2
    assert result["engine_status"]["coverage:Instagram"].startswith("1 indexed result(s)")
    assert any("Facebook: 0 indexed result(s)" in note for note in result["notes"])


def test_known_link_scan_is_public_bounded_and_audited(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    evidence = make_evidence_image()
    candidate = image_bytes(evidence.resize((128, 128), Image.Resampling.LANCZOS), "JPEG")
    page_url = "https://www.instagram.com/p/public-post/"
    login_url = "https://www.facebook.com/public-page/"
    monkeypatch.setenv("VEXALENS_IMAGE_TRACE_DB", str(tmp_path / "known-links.sqlite3"))
    monkeypatch.setattr(
        image_trace,
        "extract_public_image_urls",
        lambda url: (
            ([], "login required")
            if "facebook.com" in url
            else (["https://images.example.test/copy.jpg"], "ok: 1 public image URL(s) found")
        ),
    )
    monkeypatch.setattr(image_trace, "download_candidate_image", lambda _url: candidate)

    result = asyncio.run(
        image_trace.scan_known_links(
            image_bytes(evidence),
            [page_url, login_url],
            "I am authorized to review this public post.",
            "case-known-links",
        )
    )

    assert result["scanned_urls"] == [page_url, login_url]
    assert len(result["results"]) == 1
    assert result["results"][0]["post_url"] == page_url
    assert result["results"][0]["similarity"] >= 90
    assert result["results"][0]["verified"] is True
    assert result["results"][0]["social"] is True
    assert "login required" in result["engine_status"]["known_link_2"]
    assert "1 known-link image(s) checked" in result["engine_status"]["coverage:Instagram"]
    assert "0 known-link image(s) checked" in result["engine_status"]["coverage:Facebook"]
    assert any("Authorization note:" in note for note in result["notes"])
    assert any(f"URL scanned: {page_url}" in note for note in result["notes"])
    assert any(f"URL scanned: {login_url}" in note for note in result["notes"])
    saved = TestClient(app).get(f"/api/cases/{result['record_id']}").json()
    assert any("I am authorized" in note for note in saved["notes"])
    assert image_trace.verify_search_log()["intact"] is True


def test_known_link_extractor_stops_when_dns_is_non_public(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        image_trace,
        "_resolve_public_url",
        lambda _url: (_ for _ in ()).throw(image_trace.UnsafeImageUrlError("non-public address")),
    )
    monkeypatch.setattr(
        image_trace.subprocess,
        "run",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("gallery-dl must not run")),
    )

    image_urls, status = image_trace.extract_public_image_urls("https://private.example.test/post")

    assert image_urls == []
    assert "blocked unsafe page URL" in status


def test_gallery_dl_runs_without_user_config_or_credentials_and_caps_urls(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(image_trace, "_resolve_public_url", lambda _url: None)

    def fake_run(command: list[str], **kwargs: Any) -> SimpleNamespace:
        assert "--config-ignore" in command
        assert "--no-netrc" in command
        assert "--range" in command
        assert command[command.index("--range") + 1] == "1-50"
        assert command[command.index("--post-range") + 1] == "1-50"
        assert command[command.index("--child-range") + 1] == "1-50"
        assert "--resolve-urls" in command
        environment = kwargs["env"]
        assert environment["PYTHONPATH"] == kwargs["cwd"]
        assert environment["APPDATA"] == kwargs["cwd"]
        assert not any(key.lower().endswith("proxy") for key in environment)
        guard_path = Path(str(kwargs["cwd"])) / "sitecustomize.py"
        assert "not address.is_global" in guard_path.read_text(encoding="utf-8")
        urls = "".join(f"https://images.example.test/{index}.jpg\n" for index in range(60))
        return SimpleNamespace(stdout=urls, stderr="", returncode=0)

    monkeypatch.setattr(image_trace.subprocess, "run", fake_run)

    image_urls, status = image_trace.extract_public_image_urls("https://www.instagram.com/p/public-post/")

    assert len(image_urls) == 50
    assert status == "ok: 50 public image URL(s) found"


def test_gallery_dl_dns_guard_rejects_loopback_addresses() -> None:
    with tempfile.TemporaryDirectory(prefix="vexalens_gallery_guard_test_") as temporary_directory:
        Path(temporary_directory, "sitecustomize.py").write_text(
            image_trace._GALLERY_DL_NETWORK_GUARD,
            encoding="utf-8",
        )
        environment = os.environ.copy()
        environment["PYTHONPATH"] = temporary_directory
        result = subprocess.run(
            [
                sys.executable,
                "-c",
                "import socket; socket.getaddrinfo('127.0.0.1', 80)",
            ],
            env=environment,
            capture_output=True,
            check=False,
            text=True,
            timeout=10,
        )

    assert result.returncode != 0
    assert "Blocked non-public network address" in result.stderr


def test_scan_endpoint_records_authorization_and_returns_social_matches(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    evidence = make_evidence_image()
    candidate = image_bytes(evidence.resize((128, 128), Image.Resampling.LANCZOS), "JPEG")
    monkeypatch.setenv("VEXALENS_IMAGE_TRACE_DB", str(tmp_path / "scan-endpoint.sqlite3"))
    monkeypatch.setattr("backend.main._resolve_public_url", lambda _url: None)
    monkeypatch.setattr(image_trace, "extract_public_image_urls", lambda _url: (
        ["https://images.example.test/copy.jpg"],
        "ok: 1 public image URL(s) found",
    ))
    monkeypatch.setattr(image_trace, "download_candidate_image", lambda _url: candidate)

    response = TestClient(app).post(
        "/api/scan",
        files={"image": ("evidence.png", image_bytes(evidence), "image/png")},
        data={
            "urls": "https://www.instagram.com/p/public-post/",
            "authorization_note": "Authorized class demonstration.",
            "case_id": "scan-api-case",
        },
    )

    assert response.status_code == 200
    result = response.json()
    assert result["case_id"] == "scan-api-case"
    assert result["results"][0]["platform"] == "Instagram"
    assert result["results"][0]["similarity"] >= 90
    assert result["engine_status"]["known_link_1"].startswith("ok:")


def test_endpoint_rejects_invalid_image_bytes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VEXALENS_IMAGE_TRACE_DB", str(tmp_path / "invalid.sqlite3"))
    response = TestClient(app).post(
        "/api/trace",
        files={"image": ("image.png", b"not an image", "image/png")},
    )

    assert response.status_code == 400
    assert "readable supported image" in response.json()["detail"]


def test_root_serves_image_trace_page() -> None:
    response = TestClient(app).get("/")

    assert response.status_code == 200
    assert "text/html" in response.headers["content-type"]
    assert 'id="it-file"' in response.text
    assert 'id="it-consent"' in response.text
