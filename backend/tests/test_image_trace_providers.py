import asyncio
import base64
import json

import httpx
import pytest

from backend import image_trace_providers as providers


@pytest.mark.parametrize(
    ("engine", "env", "expected_url"),
    [
        (
            "google_vision",
            {"GOOGLE_CLOUD_VISION_API_KEY": "google-test-key"},
            providers.GOOGLE_VISION_URL,
        ),
        (
            "yandex",
            {
                "YANDEX_SEARCH_API_KEY": "yandex-test-key",
                "YANDEX_SEARCH_FOLDER_ID": "folder-test-id",
            },
            providers.YANDEX_IMAGE_SEARCH_URL,
        ),
        (
            "tineye",
            {"TINEYE_API_KEY": "tineye-test-key"},
            providers.TINEYE_SEARCH_URL,
        ),
    ],
)
def test_official_provider_request_shapes(
    engine: str,
    env: dict[str, str],
    expected_url: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for name in providers.PROVIDER_ENV[engine]:
        monkeypatch.delenv(name, raising=False)
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    captured: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        if engine == "google_vision":
            payload = {"responses": [{"webDetection": {}}]}
        elif engine == "yandex":
            payload = {"images": []}
        else:
            payload = {"code": 200, "results": {"matches": []}}
        return httpx.Response(200, json=payload)

    transport = httpx.MockTransport(handle)
    real_async_client = httpx.AsyncClient
    monkeypatch.setattr(
        providers.httpx,
        "AsyncClient",
        lambda *, timeout: real_async_client(transport=transport, timeout=timeout),
    )
    response = asyncio.run(providers.request_provider(engine, b"test-image"))

    request = captured[0]
    assert str(request.url) == expected_url
    assert request.method == "POST"
    if engine == "google_vision":
        body = json.loads(request.content)
        assert request.headers["x-goog-api-key"] == env["GOOGLE_CLOUD_VISION_API_KEY"]
        assert body["requests"][0]["features"] == [{"type": "WEB_DETECTION", "maxResults": 50}]
        assert base64.b64decode(body["requests"][0]["image"]["content"]) == b"test-image"
    elif engine == "yandex":
        body = json.loads(request.content)
        assert request.headers["authorization"] == "Api-Key yandex-test-key"
        assert body["folderId"] == "folder-test-id"
        assert base64.b64decode(body["data"]) == b"test-image"
    else:
        assert request.headers["x-api-key"] == env["TINEYE_API_KEY"]
        assert b'name="image_upload"; filename="image.jpg"' in request.content
        assert b"test-image" in request.content
    assert response.payload


def test_provider_without_credentials_is_not_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("YANDEX_SEARCH_API_KEY", raising=False)
    monkeypatch.delenv("YANDEX_SEARCH_FOLDER_ID", raising=False)

    with pytest.raises(providers.ProviderRequestError) as error:
        asyncio.run(providers.request_provider("yandex", b"image"))

    assert error.value.category == "not_configured"
    assert "YANDEX_SEARCH_API_KEY" in str(error.value)
    assert "YANDEX_SEARCH_FOLDER_ID" in str(error.value)


def test_bad_provider_api_key_is_reported_without_retry(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GOOGLE_CLOUD_VISION_API_KEY", "invalid-test-key")
    transport = httpx.MockTransport(lambda _request: httpx.Response(403, json={"error": "forbidden"}))
    real_async_client = httpx.AsyncClient
    monkeypatch.setattr(
        providers.httpx,
        "AsyncClient",
        lambda *, timeout: real_async_client(transport=transport, timeout=timeout),
    )

    with pytest.raises(providers.ProviderRequestError) as error:
        asyncio.run(providers.request_provider("google_vision", b"image"))

    assert error.value.category == "http_error"
    assert error.value.attempts == 1
    assert "API key rejected" in str(error.value)


def test_timeout_retries_once_then_reports_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TINEYE_API_KEY", "test-key")
    calls = 0

    async def timeout_request(_engine: str, _image: bytes, _timeout: float) -> httpx.Response:
        nonlocal calls
        calls += 1
        await asyncio.sleep(1)
        return httpx.Response(200, json={"code": 200, "results": {"matches": []}})

    monkeypatch.setattr(providers, "_send_request", timeout_request)

    with pytest.raises(providers.ProviderRequestError) as error:
        asyncio.run(providers.request_provider("tineye", b"image", timeout_seconds=0.04))

    assert error.value.category == "timeout"
    assert error.value.attempts == 2
    assert calls == 2


def test_http_5xx_retries_once(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("YANDEX_SEARCH_API_KEY", "test-key")
    monkeypatch.setenv("YANDEX_SEARCH_FOLDER_ID", "test-folder")
    calls = 0

    def handle(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(503)
        return httpx.Response(200, json={"images": []})

    transport = httpx.MockTransport(handle)
    real_async_client = httpx.AsyncClient
    monkeypatch.setattr(
        providers.httpx,
        "AsyncClient",
        lambda *, timeout: real_async_client(transport=transport, timeout=timeout),
    )

    response = asyncio.run(providers.request_provider("yandex", b"image"))

    assert response.payload == {"images": []}
    assert response.attempts == 2
    assert calls == 2


def test_network_error_retries_once(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TINEYE_API_KEY", "test-key")
    calls = 0

    async def flaky_request(_engine: str, _image: bytes, _timeout: float) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise httpx.ConnectError("network unavailable")
        return httpx.Response(200, json={"code": 200, "results": {"matches": []}})

    monkeypatch.setattr(providers, "_send_request", flaky_request)

    response = asyncio.run(providers.request_provider("tineye", b"image"))

    assert response.payload["results"]["matches"] == []
    assert response.attempts == 2
    assert calls == 2
