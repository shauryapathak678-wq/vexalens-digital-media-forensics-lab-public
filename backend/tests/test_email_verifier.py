import base64
import sys
from types import SimpleNamespace

import pytest

from backend import email_verifier


PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII="
)


def test_email_analysis_completes_when_ocr_is_unavailable(monkeypatch):
    monkeypatch.delenv("TESSERACT_PATH", raising=False)
    monkeypatch.delenv("TESSERACT_CMD", raising=False)
    monkeypatch.setattr(email_verifier.shutil, "which", lambda _: None)
    eml = (
        b"From: Sender <sender@example.com>\r\n"
        b"To: recipient@example.com\r\n"
        b"Subject: Evidence\r\n"
        b"MIME-Version: 1.0\r\n"
        b"Content-Type: multipart/mixed; boundary=example\r\n\r\n"
        b"--example\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello\r\n"
        b"--example\r\nContent-Type: application/octet-stream\r\n"
        b"Content-Disposition: attachment; filename=proof.bin\r\n"
        b"Content-Transfer-Encoding: base64\r\n\r\nAQID\r\n"
        b"--example--\r\n"
    )

    result = email_verifier.analyze(PNG, eml)

    assert result["screenshot"]["sha256"] == email_verifier.hashlib.sha256(PNG).hexdigest()
    assert result["screenshot"]["ocr"]["status"] == "unavailable"
    assert result["email"]["sha256"] == email_verifier.hashlib.sha256(eml).hexdigest()
    assert result["email"]["headers"]["subject"] == "Evidence"
    assert result["email"]["body"]["plainText"] == "Hello"
    assert result["email"]["attachments"][0]["name"] == "proof.bin"


def test_email_analysis_survives_unexpected_ocr_errors(monkeypatch):
    eml = b"Subject: Minimal\r\n\r\nBody"

    def fail_ocr(_image):
        raise RuntimeError("test OCR failure")

    monkeypatch.setattr(email_verifier, "_ocr", fail_ocr)
    result = email_verifier.analyze(PNG, eml)

    assert result["screenshot"]["ocr"]["status"] == "unavailable"
    assert "test OCR failure" in result["screenshot"]["ocr"]["reason"]
    assert result["email"]["headers"]["subject"] == "Minimal"


def test_parse_eml_accepts_missing_headers_and_decodes_body():
    result = email_verifier.parse_eml(b"\r\nBody without headers")

    assert result["headers"]["subject"] == ""
    assert result["body"]["plainText"] == "Body without headers"


def test_parse_msg_extracts_headers_body_and_attachments(monkeypatch):
    class FakeMessage:
        header = (
            "Received: from sender.example [8.8.8.8] by mx.example with ESMTP; "
            "Tue, 10 Nov 2026 10:00:00 +0000\r\n"
        )
        sender = "Sender <sender@example.com>"
        to = "recipient@example.com"
        cc = None
        subject = "MSG subject"
        date = None
        body = "MSG body"
        htmlBody = "<p>MSG body</p>"
        attachments = [
            SimpleNamespace(
                data=b"file",
                longFilename="proof.txt",
                shortFilename=None,
                mimetype="text/plain",
            )
        ]

        def close(self):
            pass

    monkeypatch.setitem(sys.modules, "extract_msg", SimpleNamespace(Message=lambda _path: FakeMessage()))
    raw = bytes.fromhex("D0CF11E0A1B11AE1") + b"sample"
    result = email_verifier.parse_msg(raw)

    assert result["sha256"] == email_verifier.hashlib.sha256(raw).hexdigest()
    assert result["headers"]["subject"] == "MSG subject"
    assert result["headers"]["receivedDetails"][0]["fromHost"] == "sender.example"
    assert result["body"]["plainText"] == "MSG body"
    assert result["attachments"][0]["name"] == "proof.txt"


def test_parse_msg_rejects_non_msg_data():
    with pytest.raises(email_verifier.InputError, match="not a valid Outlook MSG"):
        email_verifier.parse_msg(b"not an Outlook file")


def test_email_intelligence_traces_hops_and_detects_alignment_issues(monkeypatch):
    monkeypatch.delenv("GEOIP_DATABASE_PATH", raising=False)
    eml = (
        b"From: Billing <billing@brand.example>\r\n"
        b"To: employee@company.example\r\n"
        b"Reply-To: collect@attacker.example\r\n"
        b"Return-Path: <bounce@mailer.example>\r\n"
        b"Subject: Review invoice\r\n"
        b"X-Mailer: ExampleMailer 1.0\r\n"
        b"Authentication-Results: mx.company.example; spf=fail smtp.mailfrom=bounce@mailer.example; dkim=pass header.d=attacker.example; dmarc=fail header.from=brand.example\r\n"
        b"DKIM-Signature: v=1; d=attacker.example; s=mail; b=signature\r\n"
        b"Received: from relay.company.example (relay.company.example [10.0.0.2]) by mx.company.example with ESMTPS id newest; Tue, 10 Nov 2026 10:01:00 +0000\r\n"
        b"Received: from outbound.example (outbound.example [8.8.8.8]) by relay.company.example with ESMTP; Tue, 10 Nov 2026 10:00:00 +0000\r\n"
        b"MIME-Version: 1.0\r\n"
        b"Content-Type: text/html; charset=utf-8\r\n\r\n"
        b"<p>Visit <a href=\"https://login.attacker.example/reset\">account</a></p>"
    )

    result = email_verifier.parse_eml(eml)
    intelligence = result["intelligence"]

    assert result["headers"]["xMailer"] == "ExampleMailer 1.0"
    assert len(intelligence["deliveryPath"]) == 2
    assert intelligence["deliveryPath"][0]["delayToOlderSeconds"] == 60
    assert intelligence["deliverySummary"]["totalDelaySeconds"] == 60
    assert intelligence["deliverySummary"]["origin"]["candidateIp"] == "8.8.8.8"
    assert intelligence["deliverySummary"]["origin"]["country"] is None
    assert intelligence["authenticationAlignment"]["returnPathAligned"] is False
    assert intelligence["authenticationAlignment"]["spfDomains"] == ["mailer.example"]
    assert intelligence["authenticationAlignment"]["replyToAligned"] is False
    assert intelligence["authenticationAlignment"]["dkimDomains"][0]["aligned"] is False
    assert "https://login.attacker.example/reset" in intelligence["artifacts"]["urls"]
    assert "billing@brand.example" in intelligence["artifacts"]["emails"]
    assert any(item["address"] == "10.0.0.2" and item["scope"] == "private" for item in intelligence["artifacts"]["ips"])
    assert intelligence["risk"]["level"] == "critical"


def test_email_intelligence_does_not_invent_country_or_reputation():
    result = email_verifier.parse_eml(
        b"From: user@example.com\r\n"
        b"Received: from gateway [1.1.1.1] by mx.example with ESMTP; Tue, 10 Nov 2026 10:00:00 +0000\r\n"
        b"\r\nBody"
    )
    intelligence = result["intelligence"]

    assert intelligence["deliverySummary"]["origin"]["country"] is None
    assert "GEOIP_DATABASE_PATH" in intelligence["deliverySummary"]["geoIpNote"]
    assert "Not checked" in intelligence["artifacts"]["ips"][0]["reputation"]
    assert intelligence["risk"]["level"] == "low"
