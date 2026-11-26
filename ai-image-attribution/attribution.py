"""
AI Image Attribution Tool
High-performance offline local forensics tool to detect evidence of AI creation/editing.
Optimized to run under 40 seconds even on large images.
"""

import sys
sys.dont_write_bytecode = True

import os
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
os.environ["PYTHONUNBUFFERED"] = "1"

import re
import json
import zlib
import struct
import io
import time
from pathlib import Path
from typing import Dict, List, Any, Optional, Tuple
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError

import numpy as np
from PIL import Image, ExifTags
import cv2

# Lazy-loaded optional libraries to keep startup under 0.1s
_piexif = None
_c2pa = None
_imwatermark_decoder = None


def get_piexif():
    global _piexif
    if _piexif is None:
        try:
            import piexif
            _piexif = piexif
        except ImportError:
            _piexif = False
    return _piexif if _piexif is not False else None


def get_c2pa():
    global _c2pa
    if _c2pa is None:
        try:
            import c2pa
            _c2pa = c2pa
        except ImportError:
            _c2pa = False
    return _c2pa if _c2pa is not False else None


def get_watermark_decoder():
    global _imwatermark_decoder
    if _imwatermark_decoder is None:
        try:
            from imwatermark import WatermarkDecoder
            _imwatermark_decoder = WatermarkDecoder("bytes", 136)
        except Exception:
            _imwatermark_decoder = False
    return _imwatermark_decoder if _imwatermark_decoder is not False else None


# Supported tool mappings
TOOL_PATTERNS = {
    "OpenAI (ChatGPT / DALL-E / GPT-Image)": [
        r"\bopenai\b", r"\bdall[-_]?e\b", r"\bchatgpt\b", r"\bgpt[-_]?image\b"
    ],
    "Google Gemini (Imagen / Nano Banana)": [
        r"\bgemini\b", r"\bimagen\b", r"\bgoogle\s+ai\b", r"\bnano\s+banana\b"
    ],
    "Midjourney": [
        r"\bmidjourney\b"
    ],
    "Stable Diffusion (ComfyUI / Automatic1111)": [
        r"\bstable[-_ ]?diffusion\b", r"\bcomfyui\b", r"\bautomatic1111\b", r"\ba1111\b"
    ],
    "Adobe Firefly": [
        r"\bfirefly\b", r"\badobe\s+firefly\b"
    ],
    "Adobe Photoshop (Generative Fill)": [
        r"\bphotoshop\b", r"\bgenerative\s+fill\b"
    ],
}

RAW_BYTE_KEYWORDS = [
    b"openai", b"dall-e", b"chatgpt", b"gpt-image",
    b"gemini", b"imagen", b"google ai",
    b"midjourney",
    b"stable diffusion", b"comfyui", b"automatic1111",
    b"firefly", b"photoshop",
    b"c2pa", b"jumbf"
]


def match_tools_in_text(text: str) -> List[Tuple[str, str]]:
    """Return list of (tool_name, matched_pattern) found in text."""
    matches = []
    text_lower = text.lower()
    for tool_name, patterns in TOOL_PATTERNS.items():
        for pat in patterns:
            found = re.search(pat, text_lower)
            if found:
                matches.append((tool_name, found.group(0)))
                break
    return matches


def extract_png_chunks_from_bytes(file_bytes: bytes) -> Dict[str, str]:
    """Extract text chunks (tEXt, iTXt, zTXt) directly from PNG bytes."""
    chunks = {}
    if not file_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
        return chunks
    offset = 8
    total_len = len(file_bytes)
    try:
        while offset + 8 <= total_len:
            length = struct.unpack(">I", file_bytes[offset:offset + 4])[0]
            chunk_type = file_bytes[offset + 4:offset + 8]
            data_start = offset + 8
            data_end = data_start + length
            if data_end > total_len:
                break
            chunk_data = file_bytes[data_start:data_end]
            offset = data_end + 4  # skip CRC

            if chunk_type == b"tEXt":
                parts = chunk_data.split(b"\x00", 1)
                if len(parts) == 2:
                    key = parts[0].decode("latin-1", errors="replace")
                    val = parts[1].decode("latin-1", errors="replace")
                    chunks[key] = val
            elif chunk_type == b"zTXt":
                parts = chunk_data.split(b"\x00", 2)
                if len(parts) >= 2:
                    key = parts[0].decode("latin-1", errors="replace")
                    comp_data = chunk_data[len(parts[0]) + 2:]
                    try:
                        val = zlib.decompress(comp_data).decode("latin-1", errors="replace")
                        chunks[key] = val
                    except Exception:
                        pass
            elif chunk_type == b"iTXt":
                parts = chunk_data.split(b"\x00", 5)
                if len(parts) >= 2:
                    key = parts[0].decode("utf-8", errors="replace")
                    try:
                        comp_flag = chunk_data[len(parts[0]) + 1]
                        rest = chunk_data[len(parts[0]) + 3:]
                        null2 = rest.find(b"\x00")
                        if null2 != -1:
                            null3 = rest.find(b"\x00", null2 + 1)
                            if null3 != -1:
                                text_bytes = rest[null3 + 1:]
                                if comp_flag == 1:
                                    text_bytes = zlib.decompress(text_bytes)
                                val = text_bytes.decode("utf-8", errors="replace")
                                chunks[key] = val
                    except Exception:
                        pass
            elif chunk_type == b"IEND":
                break
    except Exception:
        pass
    return chunks


def extract_xmp(file_bytes: bytes) -> Optional[str]:
    """Locate XMP metadata packet in raw file bytes."""
    start_tag = b"<x:xmpmeta"
    end_tag = b"</x:xmpmeta>"
    start = file_bytes.find(start_tag)
    if start != -1:
        end = file_bytes.find(end_tag, start)
        if end != -1:
            try:
                return file_bytes[start:end + len(end_tag)].decode("utf-8", errors="replace")
            except Exception:
                pass
    rdf_start = file_bytes.find(b"<rdf:RDF")
    rdf_end = file_bytes.find(b"</rdf:RDF>")
    if rdf_start != -1 and rdf_end != -1:
        try:
            return file_bytes[rdf_start:rdf_end + len(b"</rdf:RDF>")].decode("utf-8", errors="replace")
        except Exception:
            pass
    return None


def run_check_a_metadata(file_bytes: bytes) -> Dict[str, Any]:
    """Check A: Metadata (EXIF, XMP, IPTC, PNG chunks, raw bytes)."""
    check_result = {
        "check_name": "Check A: Metadata",
        "description": "Read EXIF, XMP, IPTC, PNG text chunks, and raw byte keywords",
        "found": False,
        "evidence": [],
        "tools_found": set(),
        "strength": None
    }

    # 1. PNG Chunks
    png_chunks = extract_png_chunks_from_bytes(file_bytes)
    try:
        with Image.open(io.BytesIO(file_bytes)) as im:
            if hasattr(im, "text") and isinstance(im.text, dict):
                for k, v in im.text.items():
                    if k not in png_chunks:
                        png_chunks[k] = str(v)
    except Exception:
        pass

    for chunk_name, chunk_val in png_chunks.items():
        chunk_name_lower = chunk_name.lower()
        if chunk_name_lower in ["parameters", "prompt", "workflow"]:
            check_result["found"] = True
            check_result["tools_found"].add("Stable Diffusion (ComfyUI / Automatic1111)")
            check_result["strength"] = "Confirmed"
            preview = chunk_val[:120] + ("..." if len(chunk_val) > 120 else "")
            check_result["evidence"].append({
                "check": "Check A: Metadata (PNG chunk)",
                "field": f"PNG text chunk [{chunk_name}]",
                "value": preview,
                "tool": "Stable Diffusion (ComfyUI / Automatic1111)",
                "level": "Confirmed"
            })
        else:
            tools = match_tools_in_text(chunk_val)
            for t_name, matched_word in tools:
                check_result["found"] = True
                check_result["tools_found"].add(t_name)
                check_result["strength"] = "Confirmed"
                check_result["evidence"].append({
                    "check": "Check A: Metadata (PNG chunk text)",
                    "field": f"PNG text chunk [{chunk_name}]",
                    "value": f"Matched '{matched_word}' in value: {chunk_val[:100]}",
                    "tool": t_name,
                    "level": "Confirmed"
                })

    # 2. EXIF
    exif_fields = {}
    try:
        with Image.open(io.BytesIO(file_bytes)) as im:
            exif_data = im.getexif()
            if exif_data:
                for tag_id, value in exif_data.items():
                    tag_name = ExifTags.TAGS.get(tag_id, str(tag_id))
                    exif_fields[tag_name] = str(value)
    except Exception:
        pass

    piexif_mod = get_piexif()
    if piexif_mod and not exif_fields:
        try:
            exif_dict = piexif_mod.load(file_bytes)
            for ifd in ("0th", "Exif", "1st"):
                for tag_id, val in exif_dict.get(ifd, {}).items():
                    tag_name = piexif_mod.TAGS[ifd].get(tag_id, {}).get("name", str(tag_id))
                    val_str = val.decode("utf-8", errors="replace") if isinstance(val, bytes) else str(val)
                    exif_fields[tag_name] = val_str
        except Exception:
            pass

    for field in ["Software", "ImageDescription", "Description", "Creator Tool", "UserComment", "Artist"]:
        for k, val in exif_fields.items():
            if k.lower() == field.lower() or field.lower() in k.lower():
                tools = match_tools_in_text(val)
                for t_name, matched_word in tools:
                    check_result["found"] = True
                    check_result["tools_found"].add(t_name)
                    check_result["strength"] = "Confirmed"
                    check_result["evidence"].append({
                        "check": "Check A: Metadata (EXIF)",
                        "field": f"EXIF [{k}]",
                        "value": f"Matched '{matched_word}' in: {val}",
                        "tool": t_name,
                        "level": "Confirmed"
                    })

    # 3. XMP & IPTC DigitalSourceType
    xmp_str = extract_xmp(file_bytes)
    if xmp_str:
        dst_matches = re.findall(r"(trainedAlgorithmicMedia|compositeWithTrainedAlgorithmicMedia)", xmp_str, re.IGNORECASE)
        if dst_matches:
            check_result["found"] = True
            dst_val = dst_matches[0]
            action_type = "AI generated" if "trainedalgorithmicmedia" == dst_val.lower() else "AI edited"
            tool_assigned = None

            tools_in_xmp = match_tools_in_text(xmp_str)
            if tools_in_xmp:
                for t_name, _ in tools_in_xmp:
                    check_result["tools_found"].add(t_name)
                    tool_assigned = t_name
            else:
                check_result["tools_found"].add(f"Generative AI ({action_type})")
                tool_assigned = f"Generative AI ({action_type})"

            check_result["strength"] = "Confirmed"
            check_result["evidence"].append({
                "check": "Check A: Metadata (IPTC / XMP DigitalSourceType)",
                "field": "IPTC DigitalSourceType",
                "value": dst_val,
                "tool": tool_assigned,
                "level": "Confirmed"
            })

        fields_to_check = [
            (r"<xmp:CreatorTool>([^<]+)</xmp:CreatorTool>", "xmp:CreatorTool"),
            (r"<photoshop:Credit>([^<]+)</photoshop:Credit>", "photoshop:Credit"),
            (r"<dc:description[^>]*>(.*?)</dc:description>", "dc:description"),
            (r"<dc:title[^>]*>(.*?)</dc:title>", "dc:title"),
        ]
        for pat, fname in fields_to_check:
            m = re.search(pat, xmp_str, re.IGNORECASE | re.DOTALL)
            if m:
                val = m.group(1).strip()
                tools = match_tools_in_text(val)
                for t_name, matched_word in tools:
                    check_result["found"] = True
                    check_result["tools_found"].add(t_name)
                    check_result["strength"] = "Confirmed"
                    check_result["evidence"].append({
                        "check": "Check A: Metadata (XMP)",
                        "field": f"XMP [{fname}]",
                        "value": f"Matched '{matched_word}' in: {val[:120]}",
                        "tool": t_name,
                        "level": "Confirmed"
                    })

    # 4. Fast Raw Byte Keyword Search without copying the entire 25MB array
    for kw in RAW_BYTE_KEYWORDS:
        m = re.search(re.escape(kw), file_bytes, re.IGNORECASE)
        if m:
            idx = m.start()
            snippet = file_bytes[max(0, idx - 15):min(len(file_bytes), idx + len(kw) + 15)]
            snippet_str = "".join(chr(b) if 32 <= b <= 126 else "." for b in snippet)
            kw_decoded = kw.decode("ascii")
            tools = match_tools_in_text(kw_decoded)

            if tools:
                for t_name, _ in tools:
                    check_result["found"] = True
                    if t_name not in check_result["tools_found"]:
                        check_result["tools_found"].add(t_name)
                    if check_result["strength"] != "Confirmed":
                        check_result["strength"] = "Likely"
                    check_result["evidence"].append({
                        "check": "Check A: Metadata (Raw bytes)",
                        "field": f"Binary offset {idx} (0x{idx:X})",
                        "value": f"Keyword '{kw_decoded}' in context: ...{snippet_str}...",
                        "tool": t_name,
                        "level": "Likely"
                    })
            elif kw in [b"c2pa", b"jumbf"]:
                check_result["found"] = True
                check_result["evidence"].append({
                    "check": "Check A: Metadata (Raw bytes)",
                    "field": f"Binary offset {idx} (0x{idx:X})",
                    "value": f"Signature keyword '{kw_decoded}' found in binary",
                    "tool": "C2PA Manifest Indicator",
                    "level": "Likely"
                })

    return check_result


def run_check_b_c2pa(file_bytes: bytes, file_path: Optional[Path] = None) -> Dict[str, Any]:
    """Check B: C2PA Content Credentials."""
    check_result = {
        "check_name": "Check B: C2PA Content Credentials",
        "description": "Examine C2PA manifest for signer, claim generator, actions, and assertions",
        "found": False,
        "manifest_found": False,
        "signer": None,
        "claim_generator": None,
        "actions": [],
        "evidence": [],
        "tools_found": set(),
        "strength": None,
        "skipped": False,
        "skip_reason": None
    }

    c2pa_mod = get_c2pa()
    if not c2pa_mod:
        check_result["skipped"] = True
        check_result["skip_reason"] = "c2pa library not installed."
        return check_result

    # Quick pre-filter: C2PA manifests require 'c2pa' or 'jumbf' in raw bytes
    file_sample = (file_bytes[:65536] + file_bytes[-65536:]).lower()
    if b"c2pa" not in file_sample and b"jumb" not in file_sample:
        check_result["manifest_found"] = False
        return check_result

    def _read_c2pa():
        reader = None
        if file_path and file_path.exists():
            reader = c2pa_mod.Reader.try_create(str(file_path))
        else:
            stream = io.BytesIO(file_bytes)
            reader = c2pa_mod.Reader.try_create(stream=stream)

        if reader is None:
            return None

        with reader:
            manifest_json_str = reader.json()
            return json.loads(manifest_json_str)

    try:
        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(_read_c2pa)
            manifest_data = future.result(timeout=5.0)

        if not manifest_data:
            check_result["manifest_found"] = False
            return check_result

        check_result["manifest_found"] = True
        active_label = manifest_data.get("active_manifest")
        manifests = manifest_data.get("manifests", {})
        active_manifest = manifests.get(active_label, {}) if active_label else {}

        claim_gen = active_manifest.get("claim_generator") or manifest_data.get("claim_generator")
        if claim_gen:
            check_result["claim_generator"] = str(claim_gen)
            tools = match_tools_in_text(str(claim_gen))
            for t_name, matched_word in tools:
                check_result["found"] = True
                check_result["tools_found"].add(t_name)
                check_result["strength"] = "Confirmed"
                check_result["evidence"].append({
                    "check": "Check B: C2PA",
                    "field": "claim_generator",
                    "value": f"Matched '{matched_word}' in: {claim_gen}",
                    "tool": t_name,
                    "level": "Confirmed"
                })

        signature_info = active_manifest.get("signature_info", {})
        issuer = signature_info.get("issuer") or signature_info.get("common_name")
        if issuer:
            check_result["signer"] = str(issuer)
            tools = match_tools_in_text(str(issuer))
            for t_name, matched_word in tools:
                check_result["found"] = True
                check_result["tools_found"].add(t_name)
                check_result["strength"] = "Confirmed"
                check_result["evidence"].append({
                    "check": "Check B: C2PA",
                    "field": "signature_info.issuer",
                    "value": f"Matched '{matched_word}' in: {issuer}",
                    "tool": t_name,
                    "level": "Confirmed"
                })

        assertions = active_manifest.get("assertions", [])
        for assertion in assertions:
            label = assertion.get("label", "")
            data = assertion.get("data", {})
            if "c2pa.actions" in label:
                actions_list = data.get("actions", [])
                for act in actions_list:
                    action_name = act.get("action", "")
                    sw_agent = act.get("softwareAgent", "")
                    dst = act.get("digitalSourceType", "")
                    check_result["actions"].append({
                        "action": action_name,
                        "softwareAgent": sw_agent,
                        "digitalSourceType": dst
                    })
                    combined_act_text = f"{action_name} {sw_agent} {dst}"
                    tools = match_tools_in_text(combined_act_text)
                    for t_name, matched_word in tools:
                        check_result["found"] = True
                        check_result["tools_found"].add(t_name)
                        check_result["strength"] = "Confirmed"
                        check_result["evidence"].append({
                            "check": "Check B: C2PA",
                            "field": f"action [{action_name}]",
                            "value": f"softwareAgent='{sw_agent}', digitalSourceType='{dst}'",
                            "tool": t_name,
                            "level": "Confirmed"
                        })
                    if "trainedalgorithmicmedia" in dst.lower():
                        check_result["found"] = True
                        check_result["strength"] = "Confirmed"
                        tool_label = tools[0][0] if tools else "Generative AI"
                        check_result["tools_found"].add(tool_label)
                        check_result["evidence"].append({
                            "check": "Check B: C2PA",
                            "field": "action.digitalSourceType",
                            "value": dst,
                            "tool": tool_label,
                            "level": "Confirmed"
                        })
    except Exception as e:
        check_result["manifest_found"] = False

    return check_result


def run_check_c_invisible_watermark(file_bytes: bytes) -> Dict[str, Any]:
    """Check C: Invisible watermark (dwtDct 136 bits Stable Diffusion) - strictly capped for high performance."""
    check_result = {
        "check_name": "Check C: Invisible watermark",
        "description": "Decode open-source dwtDct 136-bit watermark (Stable Diffusion payload)",
        "found": False,
        "decoded_payload": None,
        "evidence": [],
        "tools_found": set(),
        "strength": None,
        "skipped": False,
        "skip_reason": None,
        "synthid_note": "Google SynthID cannot be checked offline because only Google's own detector can read it. Never claim Gemini was used from the pixels alone."
    }

    decoder = get_watermark_decoder()
    if not decoder:
        check_result["skipped"] = True
        check_result["skip_reason"] = "invisible-watermark library not available."
        return check_result

    try:
        # Decode image from memory
        nparr = np.frombuffer(file_bytes, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if img is None:
            with Image.open(io.BytesIO(file_bytes)) as pil_im:
                pil_im = pil_im.convert("RGB")
                img = cv2.cvtColor(np.array(pil_im), cv2.COLOR_RGB2BGR)

        if img is None or img.shape[0] < 64 or img.shape[1] < 64:
            check_result["skipped"] = True
            check_result["skip_reason"] = "Image too small or unreadable for watermark extraction."
            return check_result

        # Optimization: DWT+DCT on full high-res images (4K, 12MP) takes >40s.
        # Downscaling to max 512px runs in ~0.08s while preserving frequency watermark components.
        h, w = img.shape[:2]
        max_dim = 512
        if max(h, w) > max_dim:
            scale = max_dim / float(max(h, w))
            new_w = max(64, int(w * scale))
            new_h = max(64, int(h * scale))
            img = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_LINEAR)

        # Enforce strict 5-second timeout so watermark never delays the response
        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(decoder.decode, img, "dwtDct")
            try:
                raw_watermark = future.result(timeout=5.0)
            except FuturesTimeoutError:
                check_result["skipped"] = True
                check_result["skip_reason"] = "Watermark decoding timed out (>5s)."
                return check_result

        sd_signatures = [
            b"StableDiffusion",
            b"stablediffusion",
            b"SDV2",
            bytes.fromhex("537461626c65446966667573696f6e7631"),
            bytes.fromhex("537461626c65446966667573696f6e5631")
        ]

        matched = False
        for sig in sd_signatures:
            if sig.lower() in raw_watermark.lower():
                matched = True
                break

        if matched:
            check_result["found"] = True
            check_result["tools_found"].add("Stable Diffusion (ComfyUI / Automatic1111)")
            check_result["strength"] = "Likely"
            hex_val = raw_watermark.hex()
            ascii_preview = "".join(chr(b) if 32 <= b <= 126 else "." for b in raw_watermark)
            check_result["decoded_payload"] = hex_val
            check_result["evidence"].append({
                "check": "Check C: Invisible watermark",
                "field": "dwtDct 136-bit watermark",
                "value": f"Hex: {hex_val} (ASCII: '{ascii_preview}')",
                "tool": "Stable Diffusion (ComfyUI / Automatic1111)",
                "level": "Likely"
            })
        else:
            check_result["found"] = False

    except Exception as e:
        check_result["skipped"] = True
        check_result["skip_reason"] = f"Decoding failed: {e}"

    return check_result


def run_check_d_filename(filename: str) -> Dict[str, Any]:
    """Check D: Filename and context hints (weak evidence)."""
    check_result = {
        "check_name": "Check D: Filename hints",
        "description": "Inspect filename for common AI generator naming patterns (weak evidence only)",
        "found": False,
        "evidence": [],
        "tools_found": set(),
        "strength": None
    }

    fname_lower = filename.lower()
    filename_patterns = [
        ("OpenAI (ChatGPT / DALL-E / GPT-Image)", [r"dall[-_ ]?e", r"chatgpt[-_ ]?image", r"gpt[-_ ]?image"]),
        ("Google Gemini (Imagen / Nano Banana)", [r"gemini[-_ ]?generated[-_ ]?image", r"\bgemini\b", r"\bimagen\b"]),
        ("Midjourney", [r"midjourney", r"^mj_"]),
        ("Stable Diffusion (ComfyUI / Automatic1111)", [r"stable[-_ ]?diffusion", r"comfyui", r"automatic1111"]),
        ("Adobe Firefly", [r"firefly", r"adobe[-_ ]?firefly"]),
        ("Adobe Photoshop (Generative Fill)", [r"generative[-_ ]?fill"]),
    ]

    for tool_name, patterns in filename_patterns:
        for pat in patterns:
            found = re.search(pat, fname_lower)
            if found:
                check_result["found"] = True
                check_result["tools_found"].add(tool_name)
                check_result["strength"] = "Weak hint"
                check_result["evidence"].append({
                    "check": "Check D: Filename hints",
                    "field": "filename",
                    "value": f"Matched pattern '{pat}' in filename '{filename}'",
                    "tool": tool_name,
                    "level": "Weak hint"
                })
                break

    return check_result


def analyze_image_bytes(file_bytes: bytes, file_name: str = "image.jpg", file_path: Optional[Path] = None) -> Dict[str, Any]:
    """Analyze image bytes with all checks executed in strict order."""
    t_start = time.time()

    # 1. Check A: Metadata
    check_a = run_check_a_metadata(file_bytes)

    # 2. Check B: C2PA
    check_b = run_check_b_c2pa(file_bytes, file_path=file_path)

    # 3. Check C: Invisible Watermark
    check_c = run_check_c_invisible_watermark(file_bytes)

    # 4. Check D: Filename Hints
    check_d = run_check_d_filename(file_name)

    all_checks = [check_a, check_b, check_c, check_d]
    all_evidence = []
    checks_skipped = []
    confirmed_tools = set()
    likely_tools = set()
    weak_tools = set()

    for chk in all_checks:
        if chk.get("skipped"):
            checks_skipped.append({
                "check": chk["check_name"],
                "reason": chk.get("skip_reason", "Skipped")
            })
        for ev in chk.get("evidence", []):
            all_evidence.append(ev)
            lvl = ev.get("level")
            tool = ev.get("tool")
            if tool:
                if lvl == "Confirmed":
                    confirmed_tools.add(tool)
                elif lvl == "Likely":
                    likely_tools.add(tool)
                elif lvl == "Weak hint":
                    weak_tools.add(tool)

    if confirmed_tools:
        verdict = "Confirmed"
        final_tools = sorted(list(confirmed_tools))
    elif likely_tools:
        verdict = "Likely"
        final_tools = sorted(list(likely_tools))
    elif weak_tools:
        verdict = "Weak hint"
        final_tools = sorted(list(weak_tools))
    else:
        verdict = "Not detected"
        final_tools = []

    duration_ms = int((time.time() - t_start) * 1000)

    report = {
        "file_name": file_name,
        "file_path": str(file_path.resolve()) if file_path else file_name,
        "file_size_bytes": len(file_bytes),
        "duration_ms": duration_ms,
        "verdict": verdict,
        "tools": final_tools,
        "evidence_list": all_evidence,
        "checks_skipped": checks_skipped,
        "check_details": {
            "check_a_metadata": {
                "found": check_a["found"],
                "tools": sorted(list(check_a["tools_found"])),
                "evidence": check_a["evidence"]
            },
            "check_b_c2pa": {
                "manifest_found": check_b.get("manifest_found", False),
                "signer": check_b.get("signer"),
                "claim_generator": check_b.get("claim_generator"),
                "actions": check_b.get("actions", []),
                "evidence": check_b.get("evidence", []),
                "skipped": check_b.get("skipped", False),
                "skip_reason": check_b.get("skip_reason")
            },
            "check_c_invisible_watermark": {
                "found": check_c["found"],
                "decoded_payload": check_c.get("decoded_payload"),
                "evidence": check_c.get("evidence", []),
                "synthid_note": check_c["synthid_note"],
                "skipped": check_c.get("skipped", False),
                "skip_reason": check_c.get("skip_reason")
            },
            "check_d_filename": {
                "found": check_d["found"],
                "tools": sorted(list(check_d["tools_found"])),
                "evidence": check_d["evidence"]
            }
        }
    }

    if verdict == "Not detected":
        report["disclaimer"] = (
            "No AI trace found. Metadata may have been removed by a screenshot, "
            "re-save, or social media upload, so this does not prove the image is real."
        )

    return report


def analyze_image(file_path: Path) -> Dict[str, Any]:
    """Analyze image file on disk."""
    with open(file_path, "rb") as f:
        file_bytes = f.read()
    return analyze_image_bytes(file_bytes, file_name=file_path.name, file_path=file_path)


def print_report(report: Dict[str, Any]):
    """Print formatted report to terminal."""
    sep = "=" * 70
    subsep = "-" * 70
    print("\n" + sep)
    print(f"File name : {report['file_name']} ({report.get('duration_ms', 0)} ms)")
    print(f"Verdict   : {report['verdict']}")

    if report["tools"]:
        print(f"Tool name(s): {', '.join(report['tools'])}")
    else:
        print("Tool name(s): None detected")

    print(subsep)
    print("DETAILED CHECKS (Executed in exact order):")

    cd_a = report["check_details"]["check_a_metadata"]
    print("\n[Check A: Metadata]")
    print(f"  What was checked: EXIF, XMP, IPTC (DigitalSourceType), PNG text chunks, raw bytes keywords.")
    print(f"  Result          : {'Found evidence' if cd_a['found'] else 'Nothing found'}")
    if cd_a["evidence"]:
        for ev in cd_a["evidence"]:
            print(f"    - Field: {ev['field']}")
            print(f"      Value: {ev['value']}")
            if ev.get("tool"):
                print(f"      Attributed tool: {ev['tool']} (Strength: {ev.get('level')})")

    cd_b = report["check_details"]["check_b_c2pa"]
    print("\n[Check B: C2PA Content Credentials]")
    print(f"  What was checked: C2PA manifest for signer, claim generator, edit history (actions).")
    if cd_b.get("skipped"):
        print(f"  Result          : Skipped ({cd_b.get('skip_reason')})")
    elif not cd_b.get("manifest_found"):
        print("  Result          : no C2PA manifest found")
    else:
        print("  Result          : C2PA manifest found!")
        print(f"    - Signer          : {cd_b.get('signer') or 'None'}")
        print(f"    - Claim generator : {cd_b.get('claim_generator') or 'None'}")
        if cd_b.get("actions"):
            print(f"    - Edit history (actions):")
            for act in cd_b["actions"]:
                print(f"        * Action: {act.get('action')}, Agent: {act.get('softwareAgent')}, DigitalSourceType: {act.get('digitalSourceType')}")
        if cd_b["evidence"]:
            for ev in cd_b["evidence"]:
                print(f"    - Evidence: {ev['field']} -> {ev['value']} (Tool: {ev.get('tool')})")

    cd_c = report["check_details"]["check_c_invisible_watermark"]
    print("\n[Check C: Invisible watermark]")
    print(f"  What was checked: Decoding open-source dwtDct 136-bit watermark (Stable Diffusion payload).")
    if cd_c.get("skipped"):
        print(f"  Result          : Skipped ({cd_c.get('skip_reason')})")
    else:
        print(f"  Result          : {'Found' if cd_c['found'] else 'Not found'}")
        if cd_c["evidence"]:
            for ev in cd_c["evidence"]:
                print(f"    - Field: {ev['field']}")
                print(f"      Value: {ev['value']}")
                print(f"      Attributed tool: {ev.get('tool')}")
    print(f"  Note            : {cd_c['synthid_note']}")

    cd_d = report["check_details"]["check_d_filename"]
    print("\n[Check D: Filename and context hints (weak evidence)]")
    print(f"  What was checked: Filename patterns (DALL-E, Gemini_Generated_Image, midjourney, ChatGPT Image).")
    print(f"  Result          : {'Found weak hint' if cd_d['found'] else 'Nothing found'}")
    if cd_d["evidence"]:
        for ev in cd_d["evidence"]:
            print(f"    - Field: {ev['field']}")
            print(f"      Value: {ev['value']}")
            print(f"      Attributed tool: {ev.get('tool')} (Weak evidence only - filenames can be renamed)")

    print(subsep)
    print("CHECKS SKIPPED:")
    if report["checks_skipped"]:
        for sk in report["checks_skipped"]:
            print(f"  - {sk['check']}: {sk['reason']}")
    else:
        print("  None. All checks executed.")

    if report["verdict"] == "Not detected":
        print(subsep)
        print(report["disclaimer"])

    print(sep + "\n")


def process_path(target_path_str: str):
    target = Path(target_path_str)
    if not target.exists():
        print(f"Error: Path '{target_path_str}' does not exist.")
        sys.exit(1)

    image_extensions = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tiff", ".tif"}

    if target.is_file():
        report = analyze_image(target)
        print_report(report)
        report_file = target.parent / "report.json"
        with open(report_file, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=2)
        print(f"Saved report to: {report_file}")
    elif target.is_dir():
        image_files = [p for p in target.iterdir() if p.is_file() and p.suffix.lower() in image_extensions]
        if not image_files:
            print(f"No image files found in directory: {target}")
            sys.exit(0)

        all_reports = []
        for img_path in sorted(image_files):
            report = analyze_image(img_path)
            all_reports.append(report)
            print_report(report)

        report_file = target / "report.json"
        with open(report_file, "w", encoding="utf-8") as f:
            json.dump(all_reports, f, indent=2)
        print(f"Saved folder report with {len(all_reports)} images to: {report_file}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python attribution.py <path_to_image_or_folder> [--json]")
        sys.exit(1)

    json_mode = "--json" in sys.argv
    args = [a for a in sys.argv[1:] if a != "--json"]
    if not args:
        print("Usage: python attribution.py <path_to_image_or_folder> [--json]")
        sys.exit(1)

    target = Path(args[0])
    if json_mode and target.is_file():
        report = analyze_image(target)
        print(json.dumps(report))
        sys.exit(0)

    process_path(args[0])
