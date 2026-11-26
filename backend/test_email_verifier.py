from __future__ import annotations

import unittest
from unittest.mock import patch

from email_verifier import InputError, analyze, parse_eml


def eml_message(
    *,
    sender: str = "Morgan Lee <morgan@example.com>",
    recipient: str = "case@example.net",
    subject: str = "Application approved",
    date: str = "Tue, 10 Nov 2026 10:00:00 +0530",
    body: str = "Your application has been approved.",
    extra_headers: str = "",
) -> bytes:
    return (
        f"From: {sender}\r\nTo: {recipient}\r\nSubject: {subject}\r\nDate: {date}\r\n"
        f"{extra_headers}\r\n{body}\r\n"
    ).encode()


def fake_ocr(*lines: str) -> dict[str, object]:
    records = [
        {
            "text": text,
            "confidence": 96.0,
            "box": {"x": 1, "y": index * 20, "width": 200, "height": 16},
        }
        for index, text in enumerate(lines)
    ]
    return {
        "status": "complete",
        "reason": None,
        "text": "\n".join(lines),
        "lines": records,
        "words": [],
    }


class EmailVerifierTests(unittest.TestCase):
    def test_eml_hash_and_timezone_are_preserved(self) -> None:
        raw = eml_message()
        parsed = parse_eml(raw)
        self.assertEqual(len(parsed["sha256"]), 64)
        self.assertEqual(parsed["headers"]["dateUtc"], "2026-11-10T04:30:00+00:00")
        self.assertEqual(parsed["headers"]["dateStatus"], "parsed")

    def test_authentication_headers_are_recorded_not_verified(self) -> None:
        parsed = parse_eml(eml_message(extra_headers=(
            "Authentication-Results: mx.example; spf=pass; dkim=pass; dmarc=pass\r\n"
            "DKIM-Signature: v=1; a=rsa-sha256;\r\n"
        )))
        self.assertEqual(parsed["authentication"]["spf"], "recorded_pass")
        self.assertIn("no independent", parsed["authentication"]["verification"])
        self.assertTrue(parsed["authentication"]["dkimSignaturePresent"])

    def test_malformed_empty_eml_is_rejected(self) -> None:
        with self.assertRaises(InputError):
            parse_eml(b"")

    def test_html_script_content_is_not_in_plain_text(self) -> None:
        raw = (
            b"From: sender@example.com\r\nSubject: Notice\r\nContent-Type: text/html; charset=utf-8\r\n\r\n"
            b"<p>Visible message</p><script>doNotRun()</script>"
        )
        parsed = parse_eml(raw)
        self.assertIn("Visible message", parsed["body"]["htmlText"])
        self.assertNotIn("doNotRun", parsed["body"]["htmlText"])

    def test_missing_authentication_results_are_not_suspicious(self) -> None:
        parsed = parse_eml(eml_message())
        self.assertEqual(parsed["authentication"]["spf"], "not_recorded")
        self.assertEqual(parsed["authentication"]["dkim"], "not_recorded")
        self.assertEqual(parsed["authentication"]["dmarc"], "not_recorded")

    def test_screenshot_only_analysis_is_unable_to_verify(self) -> None:
        result = analyze(None, eml_message())
        self.assertEqual(result["conclusion"], "UNABLE TO VERIFY")
        self.assertTrue(result["limitations"])

    def test_no_evidence_is_rejected(self) -> None:
        with self.assertRaises(InputError):
            analyze(None, None)

    def test_malformed_authentication_header_is_only_reported_as_recorded(self) -> None:
        parsed = parse_eml(eml_message(extra_headers="Authentication-Results: attacker.invalid; spf=fail\r\n"))
        self.assertEqual(parsed["authentication"]["spf"], "recorded_fail")
        self.assertEqual(parsed["authentication"]["verification"].split(";")[0], "Recorded header results only")

    def test_identical_screenshot_and_eml_fields_match(self) -> None:
        screenshot_text = fake_ocr(
            "From: Morgan Lee <morgan@example.com>",
            "To: case@example.net",
            "Subject: Application approved",
            "Date: Tue, 10 Nov 2026 10:00:00 +0530",
            "Your application has been approved.",
        )
        with patch("email_verifier._ocr", return_value=screenshot_text):
            result = analyze(b"screenshot", eml_message())
        self.assertEqual(result["comparisons"]["sender"]["status"], "match")
        self.assertEqual(result["comparisons"]["subject"]["status"], "match")
        self.assertEqual(result["comparisons"]["body"]["status"], "match")

    def test_modified_sender_is_reported_as_mismatch(self) -> None:
        with patch("email_verifier._ocr", return_value=fake_ocr("From: attacker@example.org")):
            result = analyze(b"screenshot", eml_message())
        self.assertEqual(result["comparisons"]["sender"]["status"], "mismatch")

    def test_modified_subject_is_reported_as_mismatch(self) -> None:
        with patch("email_verifier._ocr", return_value=fake_ocr("Subject: Application declined")):
            result = analyze(b"screenshot", eml_message())
        self.assertEqual(result["comparisons"]["subject"]["status"], "mismatch")

    def test_edited_approval_sentence_is_reported_as_mismatch(self) -> None:
        with patch("email_verifier._ocr", return_value=fake_ocr("Your application has been declined.")):
            result = analyze(b"screenshot", eml_message())
        self.assertEqual(result["comparisons"]["body"]["status"], "mismatch")
        self.assertTrue(result["comparisons"]["body"]["screenshotOnly"])

    def test_timezone_conversion_is_not_reported_as_mismatch(self) -> None:
        with patch("email_verifier._ocr", return_value=fake_ocr("Date: Tue, 10 Nov 2026 04:30:00 +0000")):
            result = analyze(b"screenshot", eml_message())
        self.assertEqual(result["comparisons"]["timestamp"]["status"], "match")

    def test_screenshot_without_timezone_is_not_declared_a_forgery(self) -> None:
        with patch("email_verifier._ocr", return_value=fake_ocr("Date: Tue, 10 Nov 2026 10:00:00")):
            result = analyze(b"screenshot", eml_message())
        self.assertEqual(result["comparisons"]["timestamp"]["status"], "timezone_unavailable")


if __name__ == "__main__":
    unittest.main()
