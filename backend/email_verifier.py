from __future__ import annotations

import base64
import hashlib
import html
import ipaddress
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from email.message import EmailMessage
from email import policy
from email.header import decode_header, make_header
from email.parser import BytesParser
from email.utils import getaddresses, parsedate_to_datetime
from html.parser import HTMLParser
from difflib import SequenceMatcher
from typing import Any

MAX_IMAGE_BYTES = 25 * 1024 * 1024
MAX_EML_BYTES = 20 * 1024 * 1024
MAX_COMBINED_BYTES = 40 * 1024 * 1024
EMAIL_RE = re.compile(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", re.I)
IP_TOKEN_RE = re.compile(
    r"(?<![A-Fa-f0-9.])(?:\d{1,3}\.){3}\d{1,3}(?![A-Fa-f0-9.])"
    r"|(?<![A-Fa-f0-9:])(?:[A-Fa-f0-9]*:){2,}[A-Fa-f0-9:]*[A-Fa-f0-9](?![A-Fa-f0-9:])"
)
URL_RE = re.compile(r"\b(?:https?://|www\.)[^\s<>\"']+", re.I)
URL_TRAILING_CHARS = ".,;:!?)]}'\""
HEADER_LABELS = {
    "from": re.compile(r"^\s*(?:from|sender)\s*:\s*(.*)$", re.I),
    "to": re.compile(r"^\s*to\s*:\s*(.*)$", re.I),
    "cc": re.compile(r"^\s*cc\s*:\s*(.*)$", re.I),
    "subject": re.compile(r"^\s*subject\s*:\s*(.*)$", re.I),
    "date": re.compile(r"^\s*(?:date|sent)\s*:\s*(.*)$", re.I),
}


class InputError(ValueError):
    pass


class _VisibleText(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.hidden_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() in {"script", "style", "head"}:
            self.hidden_depth += 1
        elif tag.lower() in {"br", "p", "div", "li", "tr"} and not self.hidden_depth:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() in {"script", "style", "head"} and self.hidden_depth:
            self.hidden_depth -= 1
        elif tag.lower() in {"p", "div", "li", "tr"} and not self.hidden_depth:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self.hidden_depth:
            self.parts.append(data)


class _HtmlLinks(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.urls: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        for name, value in attrs:
            if name.lower() in {"href", "src", "action"} and value:
                self.urls.append(value.strip())


def _decode_header(value: Any) -> str:
    if value is None:
        return ""
    try:
        return str(make_header(decode_header(str(value)))).strip()
    except (LookupError, UnicodeError, ValueError):
        return str(value).strip()


def _addresses(message: Any, name: str) -> list[dict[str, str]]:
    values = getaddresses(message.get_all(name, []))
    return [{"name": _decode_header(display), "email": address.strip()} for display, address in values]


def _plain_body(message: Any) -> tuple[str, str, list[dict[str, Any]]]:
    plain: list[str] = []
    markup: list[str] = []
    attachments: list[dict[str, Any]] = []
    parts = message.walk() if message.is_multipart() else [message]
    for part in parts:
        if part.is_multipart():
            continue
        payload = part.get_payload(decode=True) or b""
        filename = part.get_filename()
        disposition = part.get_content_disposition()
        if filename or disposition == "attachment":
            attachments.append({
                "name": _decode_header(filename) or "unnamed-attachment",
                "mimeType": part.get_content_type(),
                "sha256": hashlib.sha256(payload).hexdigest(),
                "sizeBytes": len(payload),
            })
            continue
        if part.get_content_maintype() != "text":
            continue
        charset = part.get_content_charset() or "utf-8"
        try:
            text = payload.decode(charset, errors="replace")
        except LookupError:
            text = payload.decode("utf-8", errors="replace")
        if part.get_content_subtype() == "html":
            parser = _VisibleText()
            try:
                parser.feed(text)
                markup.append("".join(parser.parts))
            except Exception:
                markup.append(html.unescape(re.sub(r"<[^>]*>", " ", text)))
        else:
            plain.append(text)
    return "\n".join(plain).strip(), "\n".join(markup).strip(), attachments


def parse_eml(raw: bytes) -> dict[str, Any]:
    if not raw:
        raise InputError("The EML file is empty.")
    if len(raw) > MAX_EML_BYTES:
        raise InputError("The EML file exceeds the 20 MB limit.")
    try:
        message = BytesParser(policy=policy.default).parsebytes(raw)
        return _parse_message(message, raw)
    except InputError:
        raise
    except Exception as error:
        raise InputError(f"Could not parse email: {type(error).__name__}: {error}") from error


def parse_msg(raw: bytes) -> dict[str, Any]:
    if not raw:
        raise InputError("The MSG file is empty.")
    if len(raw) > MAX_EML_BYTES:
        raise InputError("The MSG file exceeds the 20 MB limit.")
    if not raw.startswith(bytes.fromhex("D0CF11E0A1B11AE1")):
        raise InputError("The file is not a valid Outlook MSG file.")
    try:
        import extract_msg
    except ImportError as error:
        raise InputError("Outlook MSG support is unavailable. Install backend requirements with: python -m pip install -r backend/requirements.txt") from error

    try:
        with tempfile.TemporaryDirectory(prefix="vexalens-email-") as directory:
            msg_path = os.path.join(directory, "original.msg")
            with open(msg_path, "wb") as file:
                file.write(raw)
            source = extract_msg.Message(msg_path)
            try:
                raw_headers = getattr(source, "header", None)
                if isinstance(raw_headers, bytes):
                    header_bytes = raw_headers
                elif isinstance(raw_headers, str):
                    header_bytes = raw_headers.encode("utf-8", errors="replace")
                else:
                    header_bytes = b""
                if header_bytes:
                    message = BytesParser(policy=policy.default).parsebytes(header_bytes + b"\r\n\r\n")
                else:
                    message = EmailMessage(policy=policy.default)
                for header, attribute in (
                    ("From", "sender"),
                    ("To", "to"),
                    ("Cc", "cc"),
                    ("Subject", "subject"),
                    ("Date", "date"),
                ):
                    value = getattr(source, attribute, None)
                    if value is not None and str(value).strip() and not message.get(header):
                        message[header] = str(value)

                body = getattr(source, "body", None)
                html_body = getattr(source, "htmlBody", None)
                if isinstance(body, bytes):
                    body = body.decode("utf-8", errors="replace")
                if isinstance(html_body, bytes):
                    html_body = html_body.decode("utf-8", errors="replace")
                if body:
                    message.set_content(str(body))
                else:
                    message.set_content("")
                if html_body:
                    message.add_alternative(str(html_body), subtype="html")

                for attachment in getattr(source, "attachments", []):
                    content = getattr(attachment, "data", None)
                    if not isinstance(content, bytes):
                        continue
                    filename = (
                        getattr(attachment, "longFilename", None)
                        or getattr(attachment, "shortFilename", None)
                        or "unnamed-attachment"
                    )
                    content_type = str(getattr(attachment, "mimetype", "") or "application/octet-stream")
                    maintype, _, subtype = content_type.partition("/")
                    if not subtype:
                        maintype, subtype = "application", "octet-stream"
                    message.add_attachment(content, maintype=maintype, subtype=subtype, filename=str(filename))
                return _parse_message(message, raw)
            finally:
                close = getattr(source, "close", None)
                if callable(close):
                    close()
    except InputError:
        raise
    except Exception as error:
        raise InputError(f"Could not parse Outlook MSG email: {type(error).__name__}: {error}") from error


def _parse_message(message: Any, raw: bytes) -> dict[str, Any]:
    if not message.items() and not message.get_payload():
        raise InputError("Could not parse email: the file has no recognizable headers or message body.")
    plain, markup, attachments = _plain_body(message)
    date_header = _decode_header(message.get("Date"))
    date_utc = None
    timezone_offset = None
    date_status = "missing"
    if date_header:
        try:
            parsed_date = parsedate_to_datetime(date_header)
            if parsed_date is None:
                raise ValueError("unrecognized date")
            if parsed_date.tzinfo is None:
                date_status = "timezone_missing"
            else:
                offset = parsed_date.utcoffset()
                timezone_offset = str(offset) if offset is not None else None
                date_utc = parsed_date.astimezone(timezone.utc).isoformat()
                date_status = "parsed"
        except (TypeError, ValueError, OverflowError):
            date_status = "invalid"

    headers = {
        "received": [_decode_header(value) for value in message.get_all("Received", [])],
        "returnPath": [_decode_header(value) for value in message.get_all("Return-Path", [])],
        "authenticationResults": [_decode_header(value) for value in message.get_all("Authentication-Results", [])],
        "receivedSpf": [_decode_header(value) for value in message.get_all("Received-SPF", [])],
        "dkimSignature": [_decode_header(value) for value in message.get_all("DKIM-Signature", [])],
        "xMailer": _decode_header(message.get("X-Mailer")),
        "userAgent": _decode_header(message.get("User-Agent")),
        "contentType": _decode_header(message.get("Content-Type")),
    }
    received_details = _parse_received_hops(headers["received"])
    known_headers = {
        "from", "to", "cc", "bcc", "reply-to", "subject", "message-id", "in-reply-to",
        "references", "date", "received", "return-path", "authentication-results",
        "received-spf", "dkim-signature", "x-mailer", "user-agent", "mime-version", "content-type",
        "content-transfer-encoding",
    }
    other_headers = {
        key: [_decode_header(value) for value in message.get_all(key, [])]
        for key in message.keys()
        if key.lower() not in known_headers
    }
    auth_text = " ".join(headers["authenticationResults"] + headers["receivedSpf"]).lower()
    body_text = "\n".join((plain, markup, _extract_html_links(message)))
    raw_headers = "\n".join(f"{key}: {value}" for key, value in message.items())
    intelligence = _email_intelligence(message, headers, received_details, raw_headers, body_text)

    return {
        "sha256": hashlib.sha256(raw).hexdigest(),
        "headers": {
            "from": _addresses(message, "From"),
            "to": _addresses(message, "To"),
            "cc": _addresses(message, "Cc"),
            "bcc": _addresses(message, "Bcc"),
            "replyTo": _addresses(message, "Reply-To"),
            "subject": _decode_header(message.get("Subject")),
            "messageId": _decode_header(message.get("Message-ID")),
            "inReplyTo": _decode_header(message.get("In-Reply-To")),
            "references": _decode_header(message.get("References")),
            "date": date_header,
            "dateTimezoneOffset": timezone_offset,
            "dateUtc": date_utc,
            "dateStatus": date_status,
            **headers,
            "receivedDetails": received_details,
            "other": other_headers,
            "mimeStructure": [
                {"contentType": part.get_content_type(), "disposition": part.get_content_disposition()}
                for part in (message.walk() if message.is_multipart() else [message])
            ],
        },
        "body": {"plainText": plain, "htmlText": markup},
        "attachments": attachments,
        "authentication": {
            "spf": _recorded_auth_result(auth_text, "spf"),
            "dkim": _recorded_auth_result(auth_text, "dkim"),
            "dmarc": _recorded_auth_result(auth_text, "dmarc"),
            "dkimSignaturePresent": bool(headers["dkimSignature"]),
            "verification": "Recorded header results only; no independent DNS or signature verification was performed.",
            "alignment": intelligence["authenticationAlignment"],
        },
        "intelligence": intelligence,
    }


def _extract_ip_addresses(text: str) -> list[str]:
    addresses = []
    for candidate in IP_TOKEN_RE.findall(text):
        try:
            normalized = str(ipaddress.ip_address(candidate))
        except ValueError:
            continue
        if normalized not in addresses:
            addresses.append(normalized)
    return addresses


def _parse_received_hops(received_headers: list[str]) -> list[dict[str, Any]]:
    hops: list[dict[str, Any]] = []
    for raw_header in received_headers:
        timestamp = None
        timestamp_utc = None
        date_match = re.search(r";\s*(.+)$", raw_header)
        if date_match:
            try:
                parsed_date = parsedate_to_datetime(date_match.group(1).strip())
                if parsed_date:
                    timestamp = parsed_date.isoformat()
                    if parsed_date.tzinfo is not None:
                        timestamp_utc = parsed_date.astimezone(timezone.utc).isoformat()
            except (TypeError, ValueError, OverflowError):
                pass

        from_match = re.search(r"\bfrom\s+([^\s(;]+)", raw_header, re.I)
        by_match = re.search(r"\bby\s+([^\s(;]+)", raw_header, re.I)
        protocol_match = re.search(r"\bwith\s+([^\s;(]+)", raw_header, re.I)
        hops.append({
            "raw": raw_header,
            "fromHost": from_match.group(1).strip("[]") if from_match else None,
            "byHost": by_match.group(1).strip("[]") if by_match else None,
            "protocol": protocol_match.group(1) if protocol_match else None,
            "timestamp": timestamp,
            "timestampUtc": timestamp_utc,
            "ips": _extract_ip_addresses(raw_header),
            "delayToOlderSeconds": None,
        })

    for index in range(len(hops) - 1):
        newer = hops[index].get("timestampUtc")
        older = hops[index + 1].get("timestampUtc")
        if newer and older:
            try:
                hops[index]["delayToOlderSeconds"] = int((
                    datetime.fromisoformat(newer) - datetime.fromisoformat(older)
                ).total_seconds())
            except (TypeError, ValueError, OverflowError):
                pass
    return hops


def _domain_from_address(value: str | None) -> str | None:
    if not value:
        return None
    addresses = EMAIL_RE.findall(value)
    return addresses[0].rsplit("@", 1)[1].lower().rstrip(".") if addresses else None


def _domains_align(left: str | None, right: str | None) -> bool | None:
    if not left or not right:
        return None
    left = left.lower().rstrip(".")
    right = right.lower().rstrip(".")
    return left == right or left.endswith("." + right) or right.endswith("." + left)


def _extract_html_links(message: Any) -> str:
    links: list[str] = []
    parts = message.walk() if message.is_multipart() else [message]
    for part in parts:
        if part.get_content_type() != "text/html":
            continue
        payload = part.get_payload(decode=True) or b""
        charset = part.get_content_charset() or "utf-8"
        try:
            markup = payload.decode(charset, errors="replace")
        except LookupError:
            markup = payload.decode("utf-8", errors="replace")
        parser = _HtmlLinks()
        try:
            parser.feed(markup)
            links.extend(parser.urls)
        except Exception:
            continue
    return "\n".join(links)


def _geoip_country(ip_address: str) -> str | None:
    database_path = os.environ.get("GEOIP_DATABASE_PATH", "").strip()
    if not database_path or not os.path.isfile(database_path):
        return None
    try:
        import geoip2.database
        with geoip2.database.Reader(database_path) as reader:
            return reader.country(ip_address).country.name
    except Exception:
        return None


def _geoip_unavailable_note() -> str | None:
    database_path = os.environ.get("GEOIP_DATABASE_PATH", "").strip()
    if not database_path or not os.path.isfile(database_path):
        return "Country lookup unavailable: configure GEOIP_DATABASE_PATH with a valid local GeoLite2 Country database."
    return None


def _email_intelligence(
    message: Any,
    headers: dict[str, Any],
    hops: list[dict[str, Any]],
    raw_headers: str,
    body_text: str,
) -> dict[str, Any]:
    from_addresses = _addresses(message, "From")
    from_domain = from_addresses[0]["email"].rsplit("@", 1)[1].lower() if from_addresses and "@" in from_addresses[0]["email"] else None
    return_path_domain = _domain_from_address(" ".join(headers["returnPath"]))
    reply_to_domain = _domain_from_address(_decode_header(message.get("Reply-To")))
    dkim_domains = list(dict.fromkeys(
        domain.lower().rstrip(".")
        for signature in headers["dkimSignature"]
        for domain in re.findall(r"(?:^|;)\s*d\s*=\s*([^;\s]+)", signature, re.I)
    ))
    spf_domains = []
    for value in headers["authenticationResults"] + headers["receivedSpf"]:
        for domain in re.findall(
            r"\b(?:smtp\.mailfrom|mailfrom|envelope-from)\s*=\s*<?([^;>\s]+)",
            value,
            re.I,
        ):
            normalized_domain = domain.rsplit("@", 1)[-1].lower().rstrip(".")
            if normalized_domain and normalized_domain not in spf_domains:
                spf_domains.append(normalized_domain)
    spf_aligned = _domains_align(from_domain, spf_domains[0]) if spf_domains else None
    dkim_alignment = [
        {"domain": domain, "aligned": _domains_align(from_domain, domain)}
        for domain in dkim_domains
    ]

    ip_sources: dict[str, set[str]] = {}
    for hop_index, hop in enumerate(hops):
        for address in hop["ips"]:
            ip_sources.setdefault(address, set()).add(f"Received hop {hop_index + 1}")
    for address in _extract_ip_addresses(raw_headers):
        ip_sources.setdefault(address, set()).add("Header")
    for address in _extract_ip_addresses(body_text):
        ip_sources.setdefault(address, set()).add("Body")

    ip_artifacts = []
    for address, sources in ip_sources.items():
        parsed = ipaddress.ip_address(address)
        if parsed.is_global:
            scope = "public"
        elif parsed.is_private:
            scope = "private"
        elif parsed.is_loopback:
            scope = "loopback"
        elif parsed.is_link_local:
            scope = "link_local"
        elif parsed.is_reserved or parsed.is_unspecified:
            scope = "reserved"
        else:
            scope = "non_public"
        ip_artifacts.append({
            "address": address,
            "scope": scope,
            "country": _geoip_country(address) if scope == "public" else None,
            "sources": sorted(sources),
            "reputation": "Not checked; no external reputation service was queried.",
        })

    emails = list(dict.fromkeys(EMAIL_RE.findall(raw_headers + "\n" + body_text)))
    urls = list(dict.fromkeys(
        url.rstrip(URL_TRAILING_CHARS)
        for url in URL_RE.findall(body_text + "\n" + raw_headers)
        if url.rstrip(URL_TRAILING_CHARS)
    ))
    # HTML attributes can contain URLs that are not visible in the rendered body text.
    for url in re.findall(r"(?:href|src|action)\s*=\s*[\"']([^\"']+)", body_text, re.I):
        if url.lower().startswith(("http://", "https://")) and url not in urls:
            urls.append(url)

    origin = None
    if hops:
        oldest_hop = hops[-1]
        oldest_ips = oldest_hop["ips"]
        candidates = [address for address in oldest_ips if ipaddress.ip_address(address).is_global]
        selected_ip = candidates[0] if candidates else oldest_ips[0] if oldest_ips else None
        if selected_ip:
            origin = {
                "candidateIp": selected_ip,
                "fromServer": oldest_hop["fromHost"],
                "scope": next((item["scope"] for item in ip_artifacts if item["address"] == selected_ip), "unknown"),
                "country": _geoip_country(selected_ip),
                "confidence": "candidate only; Received headers can be forged before a trusted mail server adds its own header",
            }

    total_delay = None
    if len(hops) >= 2 and hops[0]["timestampUtc"] and hops[-1]["timestampUtc"]:
        total_delay = int((
            datetime.fromisoformat(hops[0]["timestampUtc"])
            - datetime.fromisoformat(hops[-1]["timestampUtc"])
        ).total_seconds())

    auth_status = {
        name: str(_recorded_auth_result(
            " ".join(headers["authenticationResults"] + headers["receivedSpf"]).lower(),
            name,
        ))
        for name in ("spf", "dkim", "dmarc")
    }
    return_path_aligned = _domains_align(from_domain, return_path_domain)
    reply_to_aligned = _domains_align(from_domain, reply_to_domain)
    authentication_alignment = {
        "fromDomain": from_domain,
        "returnPathDomain": return_path_domain,
        "returnPathAligned": return_path_aligned,
        "spfDomains": spf_domains,
        "spfAligned": spf_aligned,
        "dkimDomains": dkim_alignment,
        "replyToDomain": reply_to_domain,
        "replyToAligned": reply_to_aligned,
        "note": "Relaxed alignment is an approximate domain-suffix comparison, not a full DMARC Public Suffix List evaluation. Header authentication results are recorded claims, not independently verified.",
    }

    findings: list[str] = []
    score = 0
    if all(value == "not_recorded" for value in auth_status.values()):
        score += 10
        findings.append("No SPF, DKIM, or DMARC result was recorded in the supplied headers; absence is inconclusive, not proof of spoofing.")
    if "fail" in auth_status["spf"]:
        score += 18
        findings.append("The supplied authentication headers report SPF failure.")
    elif "softfail" in auth_status["spf"]:
        score += 10
        findings.append("The supplied authentication headers report SPF softfail.")
    if "fail" in auth_status["dkim"]:
        score += 20
        findings.append("The supplied authentication headers report DKIM failure.")
    if "fail" in auth_status["dmarc"]:
        score += 25
        findings.append("The supplied authentication headers report DMARC failure.")
    if return_path_aligned is False:
        score += 12
        findings.append("The visible From domain does not align with the Return-Path domain.")
    if reply_to_aligned is False:
        score += 15
        findings.append("The Reply-To domain differs from the visible From domain.")
    if spf_aligned is False and "pass" in auth_status["spf"]:
        score += 12
        findings.append("The recorded SPF-authenticated domain does not align with the visible From domain.")
    if "pass" in auth_status["dmarc"] and return_path_aligned is False and not any(item["aligned"] for item in dkim_alignment):
        findings.append("DMARC is recorded as pass, but the available SPF and DKIM domains do not demonstrate alignment; inspect the trusted Authentication-Results source.")
    if total_delay is not None and total_delay < 0:
        score += 15
        findings.append("Received timestamps are out of newest-to-oldest order; clock skew, header ordering, or forged headers may explain this.")
    elif total_delay is not None and total_delay > 86_400:
        score += 10
        findings.append("The recorded end-to-end Received-header span exceeds 24 hours; delayed delivery or inconsistent clocks are possible.")
    if not findings:
        findings.append("No high-signal authentication or alignment warning was identified in the supplied headers; this does not establish that the message is safe.")
    level = "low" if score < 20 else "medium" if score < 40 else "high" if score < 70 else "critical"
    recommendation = {
        "low": "No high-signal header warning was found. This is not a safety verdict; verify unexpected requests through a known, independent channel.",
        "medium": "Treat the message as suspicious until verified. Avoid links and attachments, and confirm the sender through a known channel.",
        "high": "Escalate for security review. Do not interact with links or attachments; preserve the original and corroborate indicators using trusted sources.",
        "critical": "Quarantine pending investigation. Preserve the original and corroborate each indicator before blocking domains or infrastructure.",
    }[level]

    return {
        "deliveryPath": hops,
        "deliverySummary": {
            "hopCount": len(hops),
            "order": "newest to oldest as stored in the RFC Received header block",
            "totalDelaySeconds": total_delay,
            "origin": origin,
            "geoIpNote": _geoip_unavailable_note(),
        },
        "authenticationAlignment": authentication_alignment,
        "artifacts": {
            "ips": ip_artifacts,
            "emails": emails,
            "urls": urls,
            "reputationNote": "Reputation lookups are not performed automatically. No email artifacts were sent to third-party services.",
        },
        "risk": {"level": level, "score": score, "findings": findings, "recommendation": recommendation},
    }


def _recorded_auth_result(text: str, protocol: str) -> str:
    matches = re.findall(rf"\b{protocol}\s*=\s*(pass|fail|softfail|neutral|none|temperror|permerror)\b", text)
    if matches:
        return "recorded_" + ",".join(dict.fromkeys(matches))
    return "not_recorded"


_EASYOCR_READER = None


def _get_easyocr_reader():
    global _EASYOCR_READER
    if _EASYOCR_READER is None:
        import easyocr  # type: ignore
        import torch  # type: ignore
        gpu = torch.cuda.is_available()
        _EASYOCR_READER = easyocr.Reader(['en'], gpu=gpu, verbose=False)
    return _EASYOCR_READER


def _run_easyocr(image: bytes) -> dict[str, Any] | None:
    try:
        import io
        import numpy as np  # type: ignore
        from PIL import Image  # type: ignore
        img = Image.open(io.BytesIO(image)).convert("RGB")
        orig_w, orig_h = img.size
        # Downscale large screenshots to max 1280px for 5x-10x faster CPU inference
        scale = 1.0
        if max(orig_w, orig_h) > 1280:
            scale = 1280.0 / max(orig_w, orig_h)
            new_w = max(1, int(orig_w * scale))
            new_h = max(1, int(orig_h * scale))
            img = img.resize((new_w, new_h), Image.Resampling.BILINEAR)

        reader = _get_easyocr_reader()
        raw_results = reader.readtext(np.array(img), paragraph=False, detail=1)
        if not raw_results:
            return {"status": "no_text", "reason": "No readable text detected in screenshot.", "text": "", "lines": [], "words": []}

        inv_scale = 1.0 / scale
        lines = []
        words = []
        for bbox, text, conf in raw_results:
            text_str = str(text).strip()
            if not text_str:
                continue
            xs = [pt[0] for pt in bbox]
            ys = [pt[1] for pt in bbox]
            min_x = int(min(xs) * inv_scale)
            max_x = int(max(xs) * inv_scale)
            min_y = int(min(ys) * inv_scale)
            max_y = int(max(ys) * inv_scale)
            item = {
                "text": text_str,
                "confidence": round(float(conf) * 100, 2),
                "box": {"x": min_x, "y": min_y, "width": max(1, max_x - min_x), "height": max(1, max_y - min_y)},
            }
            lines.append(item)
            words.append({**item, "lineKey": f"line-{min_y // 20}"})

        return {
            "status": "complete",
            "reason": None,
            "text": "\n".join(l["text"] for l in lines),
            "lines": lines,
            "words": words,
        }
    except Exception:
        return None


def _ocr(image: bytes) -> dict[str, Any]:
    if not image:
        raise InputError("The screenshot file is empty.")
    if len(image) > MAX_IMAGE_BYTES:
        raise InputError("The screenshot exceeds the 25 MB limit.")
    image_format = None
    if image.startswith(b"\x89PNG\r\n\x1a\n"):
        image_format = "png"
    elif image.startswith(b"\xff\xd8\xff"):
        image_format = "jpeg"
    elif len(image) >= 12 and image[:4] == b"RIFF" and image[8:12] == b"WEBP":
        image_format = "webp"
    if not image_format:
        raise InputError("The screenshot bytes are not a supported PNG, JPEG, or WEBP image.")

    executable = (
        os.environ.get("TESSERACT_PATH", "").strip()
        or os.environ.get("TESSERACT_CMD", "").strip()
        or shutil.which("tesseract")
    )
    if not executable:
        easyocr_res = _run_easyocr(image)
        if easyocr_res is not None:
            return easyocr_res

        return {"status": "unavailable", "reason": "OCR not installed: install Tesseract or configure TESSERACT_PATH. Email parsing and hashes were completed without screenshot text.", "text": "", "lines": [], "words": []}

    try:
        process = subprocess.run(
            [executable, "stdin", "stdout", "tsv", "--psm", "6"],
            input=image,
            capture_output=True,
            check=False,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return {"status": "unavailable", "reason": f"OCR unavailable: Tesseract could not complete ({type(error).__name__}: {error}). Email parsing and hashes were completed without screenshot text.", "text": "", "lines": [], "words": []}
    if process.returncode:
        detail = process.stderr.decode("utf-8", errors="replace").strip()[:500]
        reason = f"Tesseract exited with code {process.returncode}"
        if detail:
            reason += f": {detail}"
        return {"status": "unavailable", "reason": f"OCR unavailable: {reason}. Email parsing and hashes were completed without screenshot text.", "text": "", "lines": [], "words": []}

    words: list[dict[str, Any]] = []
    line_words: dict[tuple[str, str, str, str, str], list[dict[str, Any]]] = {}
    rows = process.stdout.decode("utf-8", errors="replace").splitlines()
    for row in rows[1:]:
        fields = row.split("\t", 11)
        if len(fields) != 12 or not fields[11].strip():
            continue
        try:
            confidence = float(fields[10])
            if confidence < 0:
                continue
            word = {
                "text": fields[11].strip(),
                "confidence": round(confidence, 2),
                "box": {"x": int(fields[6]), "y": int(fields[7]), "width": int(fields[8]), "height": int(fields[9])},
                "lineKey": "-".join(fields[1:5]),
            }
        except (ValueError, IndexError):
            continue
        words.append(word)
        line_words.setdefault(tuple(fields[1:6]), []).append(word)
    lines = []
    for grouped_words in line_words.values():
        lines.append({
            "text": " ".join(word["text"] for word in grouped_words),
            "confidence": round(sum(word["confidence"] for word in grouped_words) / len(grouped_words), 2),
            "box": {
                "x": min(word["box"]["x"] for word in grouped_words),
                "y": min(word["box"]["y"] for word in grouped_words),
                "width": max(word["box"]["x"] + word["box"]["width"] for word in grouped_words) - min(word["box"]["x"] for word in grouped_words),
                "height": max(word["box"]["y"] + word["box"]["height"] for word in grouped_words) - min(word["box"]["y"] for word in grouped_words),
            },
        })
    return {
        "status": "complete" if words else "no_text",
        "reason": None if words else "OCR completed but no readable words were returned.",
        "text": "\n".join(line["text"] for line in lines),
        "lines": lines,
        "words": words,
    }


def _screenshot_fields(ocr: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    body_lines = []
    for line in ocr["lines"]:
        text = line["text"]
        matched = False
        for field, pattern in HEADER_LABELS.items():
            match = pattern.match(text)
            if match:
                value = match.group(1).strip()
                result[field] = {
                    "value": value,
                    "confidence": line["confidence"],
                    "box": line["box"],
                    "status": "extracted" if value else "not_detected",
                }
                matched = True
                break
        if not matched:
            body_lines.append(line["text"])
    email_matches = list(EMAIL_RE.finditer(ocr["text"]))
    if email_matches and "from" not in result:
        match = email_matches[0]
        matching_line = next((line for line in ocr["lines"] if match.group(0) in line["text"]), None)
        result["from"] = {
            "value": matching_line["text"] if matching_line else match.group(0),
            "confidence": matching_line["confidence"] if matching_line else None,
            "box": matching_line["box"] if matching_line else None,
            "status": "extracted",
        }
    if len(email_matches) > 1 and "to" not in result:
        match = email_matches[1]
        matching_line = next((line for line in ocr["lines"] if match.group(0) in line["text"]), None)
        result["to"] = {
            "value": match.group(0),
            "confidence": matching_line["confidence"] if matching_line else None,
            "box": matching_line["box"] if matching_line else None,
            "status": "extracted",
        }
    if "subject" not in result and ocr.get("lines"):
        for line in ocr["lines"]:
            text_strip = line["text"].strip()
            if not text_strip or len(text_strip) > 150 or "@" in text_strip:
                continue
            if text_strip.lower() in {"gmail", "search", "inbox", "sent", "archive", "spam", "trash", "settings", "menu"}:
                continue
            result["subject"] = {
                "value": text_strip,
                "confidence": line["confidence"],
                "box": line["box"],
                "status": "extracted",
            }
            break
    result["body"] = {
        "value": "\n".join(body_lines).strip(),
        "confidence": None,
        "box": None,
        "status": "extracted" if body_lines else "not_detected",
    }
    return result


def _normalize(value: str) -> str:
    return " ".join(value.casefold().split())


def _compare_value(screenshot: dict[str, Any] | None, original: str | None, *, case_sensitive: bool = False) -> dict[str, Any]:
    if not screenshot or not str(screenshot.get("value", "")).strip():
        return {"status": "not_visible", "screenshot": None, "original": original or None}
    if not original:
        return {"status": "not_provided", "screenshot": screenshot["value"], "original": None}
    if screenshot.get("confidence") is not None and screenshot["confidence"] < 45:
        return {"status": "ocr_uncertain", "screenshot": screenshot["value"], "original": original}
    normalize = (lambda text: " ".join(text.split())) if case_sensitive else _normalize
    status = "match" if normalize(screenshot["value"]) == normalize(original) else "mismatch"
    return {"status": status, "screenshot": screenshot["value"], "original": original}


def _compare_identity(screenshot: dict[str, Any] | None, original: str | None) -> dict[str, Any]:
    result = _compare_value(screenshot, original)
    if result["status"] in {"not_visible", "not_provided", "ocr_uncertain"}:
        return result
    screenshot_value = str(result["screenshot"])
    screenshot_addresses = {address.casefold() for address in EMAIL_RE.findall(screenshot_value)}
    original_addresses = {address.casefold() for address in EMAIL_RE.findall(str(original))}
    if screenshot_addresses:
        if not original_addresses:
            result["status"] = "not_comparable"
        elif screenshot_addresses == original_addresses:
            result["status"] = "match"
        elif screenshot_addresses.issubset(original_addresses):
            result["status"] = "partial_match"
        else:
            result["status"] = "mismatch"
        return result

    screenshot_name = _normalize(EMAIL_RE.sub("", screenshot_value).strip(" <>:"))
    parsed_original_names = [name for name, _ in getaddresses([str(original)]) if name.strip()]
    if screenshot_name and parsed_original_names:
        result["status"] = "partial_match" if screenshot_name == _normalize(parsed_original_names[0]) else "mismatch"
    else:
        result["status"] = "not_comparable"
    return result


def _compare_body(screenshot: dict[str, Any] | None, original: str | None) -> dict[str, Any]:
    result = _compare_value(screenshot, original)
    if result["status"] in {"not_visible", "not_provided", "ocr_uncertain"}:
        result.update({"similarity": None, "screenshotOnly": [], "originalOnly": []})
        return result
    left = _normalize(str(result["screenshot"])).split()
    right = _normalize(str(result["original"])).split()
    matcher = SequenceMatcher(a=left, b=right, autojunk=False)
    result["similarity"] = round(matcher.ratio(), 4)
    result["screenshotOnly"] = [" ".join(left[a0:a1]) for tag, a0, a1, _, _ in matcher.get_opcodes() if tag in {"replace", "insert"} and a0 < a1]
    result["originalOnly"] = [" ".join(right[b0:b1]) for tag, _, _, b0, b1 in matcher.get_opcodes() if tag in {"replace", "delete"} and b0 < b1]
    left_str = " ".join(left)
    right_str = " ".join(right)
    if not result["screenshotOnly"] and not result["originalOnly"]:
        result["status"] = "match"
    elif right_str and (right_str in left_str or result["similarity"] >= 0.85):
        result["status"] = "match"
    elif result["similarity"] >= 0.35 or any(p in left_str for p in [right_str[:min(40, len(right_str))]] if len(p) > 8):
        result["status"] = "partial_match"
    else:
        result["status"] = "mismatch" if (result["screenshotOnly"] or result["originalOnly"]) else "match"
    return result


def _compare_timestamp(screenshot: dict[str, Any] | None, original: str | None) -> dict[str, Any]:
    result = _compare_value(screenshot, original, case_sensitive=True)
    if result["status"] in {"not_visible", "not_provided", "ocr_uncertain"}:
        return result
    try:
        screenshot_date = parsedate_to_datetime(str(result["screenshot"]))
        original_date = parsedate_to_datetime(str(result["original"]))
    except (TypeError, ValueError, OverflowError):
        return result
    if screenshot_date is None or original_date is None:
        return result
    if screenshot_date.tzinfo is None or original_date.tzinfo is None:
        result["status"] = "timezone_unavailable"
        return result
    seconds = abs((screenshot_date.astimezone(timezone.utc) - original_date.astimezone(timezone.utc)).total_seconds())
    result["status"] = "match" if seconds <= 60 else "mismatch"
    return result


def _display_address(addresses: list[dict[str, str]]) -> str | None:
    if not addresses:
        return None
    return ", ".join(f'{item["name"]} <{item["email"]}>' if item["name"] else item["email"] for item in addresses)


def _timestamp_for_display(value: str | None) -> str | None:
    if not value:
        return None
    try:
        parsed = parsedate_to_datetime(value)
        return parsed.astimezone(timezone.utc).isoformat() if parsed and parsed.tzinfo else None
    except (ValueError, TypeError, OverflowError):
        return None


def analyze(
    screenshot: bytes | None,
    eml: bytes | None,
    email_format: str = "eml",
    ocr_override: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if screenshot is None and eml is None:
        raise InputError("Upload an email screenshot, an EML or MSG file, or both.")
    if (len(screenshot) if screenshot is not None else 0) + (len(eml) if eml is not None else 0) > MAX_COMBINED_BYTES:
        raise InputError("The screenshot and original email together exceed the 40 MB processing limit.")
    if screenshot is None:
        ocr = {"status": "not_provided", "reason": None, "text": "", "lines": [], "words": []}
    elif ocr_override and isinstance(ocr_override, dict) and ocr_override.get("status") in {"complete", "no_text"}:
        ocr = ocr_override
    else:
        try:
            ocr = _ocr(screenshot)
        except Exception as error:
            ocr = {
                "status": "unavailable",
                "reason": f"OCR unavailable: {type(error).__name__}: {error}. Email parsing and hashes were completed without screenshot text.",
                "text": "",
                "lines": [],
                "words": [],
            }
    screenshot_fields = _screenshot_fields(ocr)
    if email_format not in {"eml", "msg"}:
        raise InputError("Original email format must be EML or MSG.")
    email_data = (parse_msg(eml) if email_format == "msg" else parse_eml(eml)) if eml is not None else None
    comparisons: dict[str, Any] = {}
    if email_data:
        headers = email_data["headers"]
        comparisons = {
            "sender": _compare_identity(screenshot_fields.get("from"), _display_address(headers["from"])),
            "recipient": _compare_identity(screenshot_fields.get("to"), _display_address(headers["to"])),
            "cc": _compare_identity(screenshot_fields.get("cc"), _display_address(headers["cc"])),
            "subject": _compare_value(screenshot_fields.get("subject"), headers["subject"]),
            "timestamp": _compare_timestamp(screenshot_fields.get("date"), headers["date"]),
            "body": _compare_body(screenshot_fields.get("body"), email_data["body"]["plainText"] or email_data["body"]["htmlText"]),
        }
        discrepancies = [name for name, result in comparisons.items() if result["status"] == "mismatch"]
        comparable = [result for result in comparisons.values() if result["status"] in {"match", "mismatch", "partial_match"}]
        if discrepancies:
            conclusion = "DISCREPANCY DETECTED"
        elif not comparable:
            conclusion = "UNABLE TO VERIFY"
        elif all(result["status"] == "match" for result in comparable) and len(comparable) == len(comparisons):
            conclusion = "MATCHED"
        else:
            conclusion = "PARTIALLY MATCHED"
    else:
        comparisons = {name: {"status": "not_comparable", "screenshot": None, "original": None} for name in ("sender", "recipient", "cc", "subject", "timestamp", "body")}
        discrepancies = []
        conclusion = "UNABLE TO VERIFY"

    observations = []
    for name, comparison in comparisons.items():
        if comparison["status"] == "mismatch":
            observations.append({
                "title": f"{name.title()} differs",
                "description": f"The extracted screenshot {name} differs from the supplied original email {name}. OCR and timezone limitations should be considered.",
                "field": name,
                "significance": "review",
                "status": comparison["status"],
                "screenshotValue": comparison.get("screenshot"),
                "originalValue": comparison.get("original"),
            })
        elif comparison["status"] in {"not_visible", "not_provided", "ocr_uncertain"}:
            observations.append({
                "title": f"{name.title()} not fully comparable",
                "description": "The screenshot value is absent or uncertain; no manipulation conclusion is drawn from missing information.",
                "field": name,
                "significance": "informational",
                "status": comparison["status"],
                "screenshotValue": comparison.get("screenshot"),
                "originalValue": comparison.get("original"),
            })
    visibility = [
        {"information": label, "screenshot": "Visible" if field in screenshot_fields and screenshot_fields[field]["status"] == "extracted" else "Not detected",
         "original": "Available" if email_data and original_available else ("Not provided" if not email_data else "Not available")}
        for label, field, original_available in (
            ("Sender", "from", bool(email_data and email_data["headers"]["from"])),
            ("Recipient", "to", bool(email_data and email_data["headers"]["to"])),
            ("CC", "cc", bool(email_data and email_data["headers"]["cc"])),
            ("Subject", "subject", bool(email_data and email_data["headers"]["subject"])),
            ("Message body", "body", bool(email_data and (email_data["body"]["plainText"] or email_data["body"]["htmlText"]))),
            ("Message-ID", "messageId", bool(email_data and email_data["headers"]["messageId"])),
            ("Received headers", "received", bool(email_data and email_data["headers"]["received"])),
            ("SPF result", "spf", bool(email_data and email_data["authentication"]["spf"] != "not_recorded")),
            ("DKIM result", "dkim", bool(email_data and (email_data["authentication"]["dkim"] != "not_recorded" or email_data["authentication"]["dkimSignaturePresent"]))),
            ("DMARC result", "dmarc", bool(email_data and email_data["authentication"]["dmarc"] != "not_recorded")),
        )
    ]
    return {
        "schemaVersion": 1,
        "processedAt": datetime.now(timezone.utc).isoformat(),
        "screenshot": {
            "sha256": hashlib.sha256(screenshot).hexdigest() if screenshot is not None else None,
            "ocr": ocr,
            "fields": screenshot_fields,
        },
        "email": email_data,
        "comparisons": comparisons,
        "discrepancies": discrepancies,
        "visibility": visibility,
        "observations": observations,
        "conclusion": conclusion,
        "limitations": [
            "A matching screenshot and EML do not prove that the email was sent by the displayed sender.",
            "A discrepancy does not prove intentional forgery.",
            "Authentication results copied into EML headers are recorded claims, not independently verified results.",
            "A BCC recipient may not appear in a recipient's received copy.",
            "OCR can omit or misread text; uncertain OCR is not treated as a mismatch.",
        ] + ([ocr["reason"]] if ocr.get("reason") else []),
    }


def _read_base64(value: Any, field: str, limit: int) -> bytes | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise InputError(f"{field} must be base64-encoded text.")
    try:
        content = base64.b64decode(value, validate=True)
    except (ValueError, base64.binascii.Error) as error:
        raise InputError(f"{field} is not valid base64.") from error
    if len(content) > limit:
        raise InputError(f"{field} exceeds its allowed size.")
    return content


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            raise InputError("Request body must be an object.")
        image = _read_base64(payload.get("screenshot"), "Screenshot", MAX_IMAGE_BYTES)
        eml = _read_base64(payload.get("eml"), "Original email", MAX_EML_BYTES)
        email_format = payload.get("emailFormat", "eml")
        if not isinstance(email_format, str):
            raise InputError("Original email format must be EML or MSG.")
        ocr_override = payload.get("ocr") if isinstance(payload.get("ocr"), dict) else None
        result = analyze(image, eml, email_format.lower(), ocr_override=ocr_override)
    except (InputError, json.JSONDecodeError) as error:
        print(json.dumps({"error": str(error), "errorType": "InputError"}, ensure_ascii=True))
        return 2
    except Exception as error:
        print(json.dumps({"error": f"Email analysis could not be completed: {type(error).__name__}: {error}"}, ensure_ascii=True))
        return 1
    print(json.dumps(result, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
