"""Local temporal video fingerprints and cautious media-genealogy comparisons."""

from __future__ import annotations

import bisect
from contextlib import closing
import hashlib
import json
import math
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import quote_plus, urlsplit

import cv2
import numpy as np


MAX_VIDEO_BYTES = 128 * 1024 * 1024
MAX_VIDEO_DURATION_SECONDS = 600
MAX_VIDEO_SAMPLES = 600
MAX_MEDIA_COUNT = 5
DEFAULT_HASH_BITS = 256
SUPPORTED_HASH_BITS = {64, 256, 1024}
SUPPORTED_VIDEO_EXTENSIONS = {".avi", ".m4v", ".mkv", ".mov", ".mp4", ".webm"}
MATCH_THRESHOLD = 60
HASH_BACKEND = "opencv-dct-multicrop-v1"
MAX_LOCAL_DATABASE_CANDIDATES = 20


class VideoGenealogyInputError(ValueError):
    """Raised when a video cannot be safely fingerprinted."""


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as media_file:
        for chunk in iter(lambda: media_file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _bits_to_hex(bits: np.ndarray) -> str:
    value = 0
    for bit in bits.flat:
        value = (value << 1) | int(bool(bit))
    return f"{value:0{math.ceil(bits.size / 4)}x}"


def _dct_hash(gray: np.ndarray, hash_bits: int) -> str:
    side = math.isqrt(hash_bits)
    dct_size = side * 2
    resized = cv2.resize(gray, (dct_size, dct_size), interpolation=cv2.INTER_AREA)
    transformed = cv2.dct(resized.astype(np.float32))
    low_frequency = transformed[1 : side + 1, 1 : side + 1]
    return _bits_to_hex(low_frequency > float(np.median(low_frequency)))


def _frame_fingerprint(frame: np.ndarray, hash_bits: int) -> dict[str, Any]:
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    height, width = gray.shape
    crop_height = max(1, round(height * 0.84))
    crop_width = max(1, round(width * 0.84))
    top = max(0, (height - crop_height) // 2)
    left = max(0, (width - crop_width) // 2)
    center_crop = gray[top : top + crop_height, left : left + crop_width]
    sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    return {
        "hashes": [_dct_hash(gray, hash_bits), _dct_hash(center_crop, hash_bits)],
        "texture_variance": float(gray.var()),
        "sharpness": sharpness,
    }


def _audio_hashes(samples: np.ndarray, hash_bits: int) -> list[dict[str, Any]]:
    side = math.isqrt(hash_bits)
    sample_rate = 8000
    window_size = sample_rate * 2
    hop_size = sample_rate
    band_edges = np.geomspace(80, 3800, side + 1)
    fingerprints: list[dict[str, Any]] = []

    for start in range(0, max(0, len(samples) - window_size + 1), hop_size):
        window = samples[start : start + window_size].astype(np.float32) / 32768.0
        if float(np.sqrt(np.mean(window * window))) < 0.0001:
            continue
        features = np.zeros((side, side), dtype=np.float32)
        segment_size = window_size // side
        for time_index in range(side):
            segment = window[time_index * segment_size : (time_index + 1) * segment_size]
            spectrum = np.abs(np.fft.rfft(segment * np.hanning(len(segment))))
            frequencies = np.fft.rfftfreq(len(segment), d=1 / sample_rate)
            for band_index in range(side):
                selected = (frequencies >= band_edges[band_index]) & (frequencies < band_edges[band_index + 1])
                if np.any(selected):
                    features[time_index, band_index] = float(np.mean(spectrum[selected]))
        features = np.log1p(features)
        fingerprints.append({
            "timestamp_seconds": start / sample_rate,
            "hashes": [_bits_to_hex(features > float(np.median(features)))],
        })
    return fingerprints


def _extract_audio(path: Path, hash_bits: int) -> dict[str, Any]:
    ffprobe = shutil.which("ffprobe")
    ffmpeg = shutil.which("ffmpeg")
    if not ffprobe or not ffmpeg:
        return {
            "status": "unavailable",
            "message": "Audio fingerprints need ffprobe and ffmpeg on PATH.",
            "frames": [],
        }

    try:
        probe = subprocess.run(
            [
                ffprobe, "-v", "error", "-select_streams", "a:0",
                "-show_entries", "stream=index", "-of", "csv=p=0", str(path),
            ],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return {"status": "unavailable", "message": "ffprobe timed out while inspecting the audio stream.", "frames": []}
    if probe.returncode != 0:
        return {
            "status": "unavailable",
            "message": (probe.stderr.strip() or "ffprobe could not inspect the audio stream.")[-500:],
            "frames": [],
        }
    if not probe.stdout.strip():
        return {"status": "not_present", "message": "No audio stream was found.", "frames": []}

    try:
        extraction = subprocess.run(
            [
                ffmpeg, "-v", "error", "-i", str(path), "-map", "0:a:0",
                "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1",
            ],
            capture_output=True,
            timeout=30,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return {"status": "unavailable", "message": "ffmpeg timed out while extracting audio samples.", "frames": []}
    if extraction.returncode != 0:
        message = extraction.stderr.decode("utf-8", errors="replace").strip()
        return {
            "status": "unavailable",
            "message": (message or "ffmpeg could not decode the audio stream.")[-500:],
            "frames": [],
        }
    samples = np.frombuffer(extraction.stdout, dtype="<i2")
    frames = _audio_hashes(samples, hash_bits)
    if not frames:
        return {"status": "not_analyzed", "message": "The audio track is too short or silent.", "frames": []}
    return {"status": "available", "message": "Audio fingerprints were computed locally.", "frames": frames}


def fingerprint_video(path: Path, label: str, hash_bits: int = DEFAULT_HASH_BITS) -> dict[str, Any]:
    """Generate one visual hash per second and overlapping audio-window hashes."""
    if hash_bits not in SUPPORTED_HASH_BITS:
        raise VideoGenealogyInputError("Choose a 64, 256, or 1024-bit fingerprint.")
    if path.suffix.lower() not in SUPPORTED_VIDEO_EXTENSIONS:
        raise VideoGenealogyInputError("Choose an AVI, M4V, MKV, MOV, MP4, or WebM video.")
    file_size = path.stat().st_size
    if file_size <= 0 or file_size > MAX_VIDEO_BYTES:
        raise VideoGenealogyInputError("Each video must be non-empty and no larger than 128 MiB.")

    capture = cv2.VideoCapture(str(path))
    if not capture.isOpened():
        capture.release()
        raise VideoGenealogyInputError(f"{label} could not be opened by the local video decoder.")
    try:
        frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
        fps = float(capture.get(cv2.CAP_PROP_FPS))
        width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
        if frame_count < 1 or not math.isfinite(fps) or fps <= 0 or width < 1 or height < 1:
            raise VideoGenealogyInputError(f"{label} has invalid frame-rate or dimension metadata.")
        duration = frame_count / fps
        if not math.isfinite(duration) or duration <= 0 or duration > MAX_VIDEO_DURATION_SECONDS:
            raise VideoGenealogyInputError(
                f"{label} must be no longer than {MAX_VIDEO_DURATION_SECONDS} seconds."
            )

        timestamps = np.arange(0.0, duration, 1.0)[:MAX_VIDEO_SAMPLES]
        if len(timestamps) == 0:
            timestamps = np.array([0.0])
        frames: list[dict[str, Any]] = []
        sharpness_values: list[float] = []
        for timestamp in timestamps:
            capture.set(cv2.CAP_PROP_POS_MSEC, float(timestamp) * 1000)
            read_ok, frame = capture.read()
            if not read_ok or frame is None:
                continue
            fingerprint = _frame_fingerprint(frame, hash_bits)
            fingerprint["timestamp_seconds"] = round(float(timestamp), 3)
            sharpness_values.append(fingerprint["sharpness"])
            frames.append(fingerprint)
    finally:
        capture.release()

    if not frames:
        raise VideoGenealogyInputError(f"No readable frames were found in {label}.")

    audio = _extract_audio(path, hash_bits)
    return {
        "label": label,
        "sha256": _sha256_file(path),
        "size_bytes": file_size,
        "hash_bits": hash_bits,
        "hash_backend": HASH_BACKEND,
        "video": {
            "duration_seconds": round(duration, 3),
            "fps": round(fps, 3),
            "width": width,
            "height": height,
            "frame_count": frame_count,
            "sample_count": len(frames),
            "sample_interval_seconds": 1.0,
            "average_laplacian_sharpness": round(float(np.mean(sharpness_values)), 3),
        },
        "audio": audio,
        "frames": frames,
    }


def _hamming_distance(first: str, second: str) -> int:
    return (int(first, 16) ^ int(second, 16)).bit_count()


def _monotonic_matches(
    first_frames: list[dict[str, Any]],
    second_frames: list[dict[str, Any]],
    hash_bits: int,
    distance_limit: int,
    require_texture: bool,
) -> tuple[list[tuple[int, int, int]], int]:
    raw_matches: list[tuple[int, int, int]] = []
    usable_first = 0
    usable_second = [
        (index, frame)
        for index, frame in enumerate(second_frames)
        if not require_texture or float(frame.get("texture_variance", 0)) >= 5
    ]
    for first_index, first_frame in enumerate(first_frames):
        if require_texture and float(first_frame.get("texture_variance", 0)) < 5:
            continue
        usable_first += 1
        first_hashes = first_frame.get("hashes", [])
        best: tuple[int, int] | None = None
        for second_index, second_frame in usable_second:
            distance = min(
                _hamming_distance(first_hash, second_hash)
                for first_hash in first_hashes
                for second_hash in second_frame.get("hashes", [])
            )
            if best is None or distance < best[0]:
                best = (distance, second_index)
        if best and best[0] <= distance_limit:
            raw_matches.append((first_index, best[1], best[0]))

    tails: list[int] = []
    tail_positions: list[int] = []
    previous = [-1] * len(raw_matches)
    for position, (_, second_index, _) in enumerate(raw_matches):
        insertion = bisect.bisect_left(tails, second_index)
        if insertion == len(tails):
            tails.append(second_index)
            tail_positions.append(position)
        else:
            tails[insertion] = second_index
            tail_positions[insertion] = position
        if insertion:
            previous[position] = tail_positions[insertion - 1]
    selected: list[tuple[int, int, int]] = []
    if tail_positions:
        position = tail_positions[-1]
        while position >= 0:
            selected.append(raw_matches[position])
            position = previous[position]
        selected.reverse()
    return selected, usable_first


def _sequence_similarity(
    first_frames: list[dict[str, Any]],
    second_frames: list[dict[str, Any]],
    hash_bits: int,
    distance_ratio: float,
    require_texture: bool,
) -> dict[str, Any] | None:
    if not first_frames or not second_frames:
        return None
    matches, usable_first = _monotonic_matches(
        first_frames,
        second_frames,
        hash_bits,
        int(hash_bits * distance_ratio),
        require_texture,
    )
    if not matches:
        return {"score": 0, "matched_samples": 0, "average_hamming_distance": None}
    usable_second = sum(
        1 for frame in second_frames
        if not require_texture or float(frame.get("texture_variance", 0)) >= 5
    )
    denominator = min(usable_first, usable_second)
    coverage = len(matches) / max(1, denominator)
    average_distance = sum(match[2] for match in matches) / len(matches)
    score = 100 * (0.7 * min(1.0, coverage) + 0.3 * (1 - average_distance / hash_bits))
    if denominator < 3:
        score = min(score, 59)
    return {
        "score": round(max(0.0, min(100.0, score)), 1),
        "matched_samples": len(matches),
        "average_hamming_distance": round(average_distance, 2),
    }


def _quality_signals(first: dict[str, Any], second: dict[str, Any]) -> dict[str, Any]:
    first_video = first["video"]
    second_video = second["video"]
    first_pixels = first_video["width"] * first_video["height"]
    second_pixels = second_video["width"] * second_video["height"]
    first_sharpness = first_video["average_laplacian_sharpness"]
    second_sharpness = second_video["average_laplacian_sharpness"]
    return {
        "file_size_ratio_smaller_to_larger": round(
            min(first["size_bytes"], second["size_bytes"]) / max(first["size_bytes"], second["size_bytes"]), 3
        ),
        "pixel_count_ratio_smaller_to_larger": round(min(first_pixels, second_pixels) / max(first_pixels, second_pixels), 3),
        "sharpness_ratio_smaller_to_larger": round(
            min(first_sharpness, second_sharpness) / max(first_sharpness, second_sharpness, 0.001), 3
        ),
        "interpretation": "Size, resolution, and sharpness differences describe the files; they do not prove which was edited first.",
    }


def _compare_pair(first: dict[str, Any], second: dict[str, Any]) -> dict[str, Any]:
    if first["sha256"] == second["sha256"]:
        visual = {
            "score": 100.0,
            "matched_samples": min(first["video"]["sample_count"], second["video"]["sample_count"]),
            "average_hamming_distance": 0.0,
        }
    else:
        visual = _sequence_similarity(
            first["frames"], second["frames"], first["hash_bits"], 0.22, True
        )
    audio = _sequence_similarity(
        first["audio"]["frames"], second["audio"]["frames"], first["hash_bits"], 0.30, False
    )
    visual_score = visual["score"] if visual else 0.0
    if audio and first["audio"]["status"] == "available" and second["audio"]["status"] == "available":
        combined = 0.75 * visual_score + 0.25 * audio["score"]
        audio_score: float | None = audio["score"]
        scoring_method = "75% visual sequence + 25% audio sequence"
    else:
        combined = visual_score
        audio_score = None
        scoring_method = "visual sequence only; audio was unavailable for one or both files"
    return {
        "first_id": first["id"],
        "second_id": second["id"],
        "match_confidence": round(combined, 1),
        "visual_similarity": round(visual_score, 1),
        "audio_similarity": audio_score,
        "matched_visual_samples": visual["matched_samples"] if visual else 0,
        "matched_audio_samples": audio["matched_samples"] if audio else 0,
        "average_visual_hamming_distance": visual["average_hamming_distance"] if visual else None,
        "scoring_method": scoring_method,
        "quality_signals": _quality_signals(first, second),
        "direction_hypothesis": (
            "The selected reference roots the display tree; file measurements do not establish chronological edit direction."
        ),
    }


def _build_clusters(files: list[dict[str, Any]], comparisons: list[dict[str, Any]]) -> list[dict[str, Any]]:
    parent = list(range(len(files)))

    def find(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def union(first: int, second: int) -> bool:
        first_root = find(first)
        second_root = find(second)
        if first_root == second_root:
            return False
        parent[second_root] = first_root
        return True

    id_to_index = {media["id"]: index for index, media in enumerate(files)}
    accepted = [
        item for item in comparisons
        if item["match_confidence"] >= MATCH_THRESHOLD
    ]
    for comparison in accepted:
        union(id_to_index[comparison["first_id"]], id_to_index[comparison["second_id"]])

    grouped: dict[int, list[int]] = {}
    for index in range(len(files)):
        grouped.setdefault(find(index), []).append(index)

    clusters: list[dict[str, Any]] = []
    for component in grouped.values():
        component_ids = {files[index]["id"] for index in component}
        component_edges = [
            item for item in accepted
            if item["first_id"] in component_ids and item["second_id"] in component_ids
        ]
        anchor_index = 0 if 0 in component else min(component)

        local_parent = {files[index]["id"]: files[index]["id"] for index in component}

        def local_find(media_id: str) -> str:
            while local_parent[media_id] != media_id:
                local_parent[media_id] = local_parent[local_parent[media_id]]
                media_id = local_parent[media_id]
            return media_id

        tree_edges: list[dict[str, Any]] = []
        for edge in sorted(component_edges, key=lambda item: item["match_confidence"], reverse=True):
            first_root = local_find(edge["first_id"])
            second_root = local_find(edge["second_id"])
            if first_root == second_root:
                continue
            local_parent[second_root] = first_root
            tree_edges.append(edge)

        adjacency: dict[str, list[tuple[str, dict[str, Any]]]] = {media_id: [] for media_id in component_ids}
        for edge in tree_edges:
            adjacency[edge["first_id"]].append((edge["second_id"], edge))
            adjacency[edge["second_id"]].append((edge["first_id"], edge))
        oriented: list[dict[str, Any]] = []
        seen = {files[anchor_index]["id"]}
        queue = [files[anchor_index]["id"]]
        while queue:
            source_id = queue.pop(0)
            for target_id, edge in adjacency[source_id]:
                if target_id in seen:
                    continue
                seen.add(target_id)
                queue.append(target_id)
                oriented.append({
                    "source_id": source_id,
                    "target_id": target_id,
                    "match_confidence": edge["match_confidence"],
                    "visual_similarity": edge["visual_similarity"],
                    "audio_similarity": edge["audio_similarity"],
                    "direction_hypothesis": edge["direction_hypothesis"],
                })
        clusters.append({
            "id": f"cluster-{len(clusters) + 1}",
            "anchor_id": files[anchor_index]["id"],
            "media_ids": [files[index]["id"] for index in component],
            "tree_edges": oriented,
        })
    return clusters


def _youtube_search(query: str) -> dict[str, Any]:
    command = [
        sys.executable, "-m", "yt_dlp",
        "--flat-playlist", "--dump-single-json", "--skip-download",
        "--no-warnings", "--no-progress", f"ytsearch8:{query}",
    ]
    try:
        completed = subprocess.run(command, capture_output=True, text=True, timeout=45, check=False)
    except subprocess.TimeoutExpired:
        return {"status": "failed", "message": "YouTube metadata search timed out after 45 seconds.", "candidates": []}
    except FileNotFoundError:
        return {"status": "failed", "message": "yt-dlp is not installed in the backend Python environment.", "candidates": []}
    if completed.returncode != 0:
        message = completed.stderr.strip() or "yt-dlp could not complete the YouTube metadata search."
        return {"status": "failed", "message": message[-500:], "candidates": []}
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError:
        return {"status": "failed", "message": "yt-dlp returned invalid search metadata.", "candidates": []}
    entries = payload.get("entries") if isinstance(payload, dict) else None
    candidates: list[dict[str, Any]] = []
    if isinstance(entries, list):
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            video_id = entry.get("id")
            page_url = entry.get("webpage_url")
            parsed_url = urlsplit(page_url) if isinstance(page_url, str) else None
            allowed_host = parsed_url and parsed_url.scheme == "https" and parsed_url.hostname in {
                "youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be",
            }
            if not allowed_host:
                if isinstance(video_id, str) and video_id and all(
                    character.isalnum() or character in "_-" for character in video_id
                ):
                    page_url = f"https://www.youtube.com/watch?v={video_id}"
                else:
                    continue
            candidates.append({
                "title": str(entry.get("title") or "Untitled video")[:300],
                "channel": str(entry.get("channel") or entry.get("uploader") or "Unknown channel")[:200],
                "duration_seconds": entry.get("duration") if isinstance(entry.get("duration"), (int, float)) else None,
                "url": page_url,
            })
    return {
        "status": "completed",
        "message": "YouTube text-search metadata only; candidate media was not downloaded.",
        "candidates": candidates,
    }


def _validate_custom_links(links: list[str]) -> list[dict[str, str]]:
    if len(links) > 10:
        raise VideoGenealogyInputError("Add no more than ten custom source links.")
    validated: list[dict[str, str]] = []
    for link in links:
        link = link.strip()
        try:
            parsed = urlsplit(link)
        except ValueError as exc:
            raise VideoGenealogyInputError("Custom sources must be valid HTTPS links. Links are displayed only and are never fetched.") from exc
        if (
            len(link) > 2000
            or any(ord(char) < 32 for char in link)
            or parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username
            or parsed.password
        ):
            raise VideoGenealogyInputError("Custom sources must be valid HTTPS links. Links are displayed only and are never fetched.")
        validated.append({"provider": "User-provided", "url": link})
    return validated


def _search_sources(query: str, enabled: bool, custom_links: list[str]) -> dict[str, Any]:
    validated_links = _validate_custom_links(custom_links)
    if not enabled:
        if not validated_links:
            return {"status": "not_requested", "query": "", "youtube": {"status": "not_requested", "candidates": []}, "search_links": [], "custom_links": []}
        return {
            "status": "links_only",
            "query": "",
            "youtube": {"status": "not_requested", "candidates": []},
            "search_links": [],
            "custom_links": validated_links,
        }
    query = query.strip()
    if not query or len(query) > 200 or any(ord(char) < 32 for char in query):
        raise VideoGenealogyInputError("Enter a search phrase of 1–200 printable characters before enabling online search.")
    encoded = quote_plus(query)
    return {
        "status": "completed",
        "query": query,
        "youtube": _youtube_search(query),
        "search_links": [
            {"provider": "Google", "url": f"https://www.google.com/search?q={encoded}"},
            {"provider": "Bing", "url": f"https://www.bing.com/search?q={encoded}"},
            {"provider": "YouTube", "url": f"https://www.youtube.com/results?search_query={encoded}"},
        ],
        "custom_links": validated_links,
    }


def _database_path() -> Path:
    configured_path = os.environ.get("VEXALENS_VIDEO_GENEALOGY_DB", "").strip()
    return Path(configured_path) if configured_path else Path(__file__).parent / "data" / "video_genealogy.sqlite3"


def _load_local_database_fingerprints(hash_bits: int) -> list[dict[str, Any]]:
    database_path = _database_path()
    if not database_path.exists():
        return []
    with closing(sqlite3.connect(database_path)) as connection:
        table_exists = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'media_fingerprints'"
        ).fetchone()
        if not table_exists:
            return []
        rows = connection.execute(
            """SELECT fingerprint_json FROM media_fingerprints
               ORDER BY last_seen_at DESC LIMIT ?""",
            (MAX_LOCAL_DATABASE_CANDIDATES,),
        ).fetchall()
    fingerprints: list[dict[str, Any]] = []
    for (fingerprint_json,) in rows:
        media = json.loads(fingerprint_json)
        if not isinstance(media, dict):
            raise RuntimeError("The local video-fingerprint database contains an invalid record.")
        if media.get("hash_bits") != hash_bits:
            continue
        sha256 = media.get("sha256")
        if not isinstance(sha256, str) or not re.fullmatch(r"[a-f0-9]{64}", sha256):
            raise RuntimeError("The local video-fingerprint database contains an invalid SHA-256 record.")
        media["id"] = f"local-{sha256}"
        media["source"] = "local_database"
        fingerprints.append(media)
    return fingerprints


def _persist_analysis(result: dict[str, Any]) -> None:
    database_path = _database_path()
    database_path.parent.mkdir(parents=True, exist_ok=True)
    now = result["analyzed_at"]
    with closing(sqlite3.connect(database_path)) as connection, connection:
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute(
            """CREATE TABLE IF NOT EXISTS media_fingerprints (
                sha256 TEXT PRIMARY KEY,
                label TEXT NOT NULL,
                fingerprint_json TEXT NOT NULL,
                first_seen_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL
            )"""
        )
        connection.execute(
            """CREATE TABLE IF NOT EXISTS genealogy_analyses (
                analysis_id TEXT PRIMARY KEY,
                reference_sha256 TEXT NOT NULL,
                analyzed_at TEXT NOT NULL,
                result_json TEXT NOT NULL
            )"""
        )
        connection.execute(
            """CREATE TABLE IF NOT EXISTS genealogy_audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                analysis_id TEXT NOT NULL,
                action TEXT NOT NULL,
                media_count INTEGER NOT NULL,
                reference_sha256 TEXT NOT NULL,
                online_search_requested INTEGER NOT NULL,
                created_at TEXT NOT NULL
            )"""
        )
        for media in result["_fingerprints"]:
            connection.execute(
                """INSERT INTO media_fingerprints (sha256, label, fingerprint_json, first_seen_at, last_seen_at)
                   VALUES (?, ?, ?, ?, ?)
                   ON CONFLICT(sha256) DO UPDATE SET
                     label = excluded.label,
                     fingerprint_json = excluded.fingerprint_json,
                     last_seen_at = excluded.last_seen_at""",
                (media["sha256"], media["label"], json.dumps(media, separators=(",", ":")), now, now),
            )
        connection.execute(
            "INSERT INTO genealogy_analyses (analysis_id, reference_sha256, analyzed_at, result_json) VALUES (?, ?, ?, ?)",
            (result["analysis_id"], result["files"][0]["sha256"], now, json.dumps(result, separators=(",", ":"))),
        )
        connection.execute(
            """INSERT INTO genealogy_audit_log
               (analysis_id, action, media_count, reference_sha256, online_search_requested, created_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (
                result["analysis_id"],
                "local_video_genealogy_completed",
                len(result["files"]),
                result["files"][0]["sha256"],
                int(result["search"]["status"] != "not_requested"),
                now,
            ),
        )


def persist_video_genealogy_analysis(result: dict[str, Any]) -> None:
    """Save a custody-verified analysis and discard its internal fingerprint payload."""
    _persist_analysis(result)
    result.pop("_fingerprints", None)


def analyze_video_set(
    paths: list[Path],
    labels: list[str],
    hash_bits: int,
    online_search: bool,
    search_query: str,
    custom_source_links: list[str] | None = None,
    persist: bool = True,
) -> dict[str, Any]:
    if not paths or len(paths) > MAX_MEDIA_COUNT or len(paths) != len(labels):
        raise VideoGenealogyInputError("Choose one reference video and up to four candidate videos.")
    if hash_bits not in SUPPORTED_HASH_BITS:
        raise VideoGenealogyInputError("Choose a 64, 256, or 1024-bit fingerprint.")

    fingerprints = [
        fingerprint_video(path, label, hash_bits)
        for path, label in zip(paths, labels)
    ]
    for index, media in enumerate(fingerprints):
        media["id"] = f"media-{index + 1}"

    comparisons: list[dict[str, Any]] = []
    for first_index in range(len(fingerprints)):
        for second_index in range(first_index + 1, len(fingerprints)):
            comparisons.append(_compare_pair(fingerprints[first_index], fingerprints[second_index]))
    local_database_matches: list[dict[str, Any]] = []
    matched_database_fingerprints: list[dict[str, Any]] = []
    for historical in _load_local_database_fingerprints(hash_bits):
        comparison = _compare_pair(fingerprints[0], historical)
        if comparison["match_confidence"] < MATCH_THRESHOLD:
            continue
        comparisons.append(comparison)
        matched_database_fingerprints.append(historical)
        local_database_matches.append({
            "id": historical["id"],
            "label": historical["label"],
            "sha256": historical["sha256"],
            "video": historical["video"],
            "audio": {
                "status": historical["audio"]["status"],
                "message": historical["audio"]["message"],
                "sample_count": len(historical["audio"]["frames"]),
            },
            "match_confidence": comparison["match_confidence"],
            "matched_against_id": fingerprints[0]["id"],
        })
    cluster_files = [*fingerprints, *matched_database_fingerprints]
    clusters = _build_clusters(cluster_files, comparisons)
    search = _search_sources(search_query, online_search, custom_source_links or [])
    public_files = [
        {
            "id": media["id"],
            "label": media["label"],
            "sha256": media["sha256"],
            "size_bytes": media["size_bytes"],
            "video": media["video"],
            "audio": {
                "status": media["audio"]["status"],
                "message": media["audio"]["message"],
                "sample_count": len(media["audio"]["frames"]),
            },
            "custody": {
                "source_sha256": media["sha256"],
                "analysis_copy_sha256": media["sha256"],
                "original_unchanged": True,
            },
        }
        for media in fingerprints
    ]
    result: dict[str, Any] = {
        "analysis_id": str(uuid.uuid4()),
        "analyzed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "root_id": fingerprints[0]["id"],
        "hash_bits": hash_bits,
        "hash_backend": HASH_BACKEND,
        "files": public_files,
        "local_database_matches": local_database_matches,
        "comparisons": comparisons,
        "clusters": clusters,
        "search": search,
        "persistence": "local_sqlite",
        "limitations": [
            "Perceptual similarities are leads, not proof that two videos share an origin.",
            "The selected reference roots the display tree. Compression, size, sharpness, or metadata cannot reliably establish historical edit order.",
            "The 256-bit default uses dense one-second visual samples and overlapping audio windows; it is not a guarantee against every crop, overlay, speed change, or color transform.",
            "YouTube discovery uses the examiner's text query, not visual-hash search. Google and Bing links open ordinary text-search pages; no public visual-hash API is implied.",
            "Online search is optional. yt-dlp retrieves YouTube search metadata only; it does not download candidate video content.",
            f"Local database comparisons use up to the {MAX_LOCAL_DATABASE_CANDIDATES} most recently seen compatible fingerprints. Only hashes, sampled fingerprints, metadata, and analysis records are stored in SQLite; uploaded media is analyzed from a temporary copy and then removed.",
        ],
        "_fingerprints": fingerprints,
    }
    if persist:
        persist_video_genealogy_analysis(result)
    return result
