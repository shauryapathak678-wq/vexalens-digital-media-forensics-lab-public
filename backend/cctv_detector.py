#!/usr/bin/env python3
"""
CCTV footage tamper detector for the Digital Forensics Lab (offline, no API keys).

Needs: numpy + opencv-python (cv2). OpenCV supplies timestamps directly.

What it checks
  1. Timing gaps      - frame timestamps jump (frames or a whole segment removed).
  2. Discontinuities  - one frame differs hugely from calm neighbours (cut/splice).
  3. Frozen frames    - a run of identical frames (feed paused, frame duplicated).
  4. Replayed footage - a moving segment that appears again later (loop/copy-paste).
  5. Activity events  - when real motion happens (useful timeline for the investigator).

IMPORTANT: these are INDICATORS, not proof. Re-encoding, camera glitches or motion
detection settings can cause similar signs. A human examiner must confirm.

Usage:  python cctv_detector.py video.mp4
"""
import hashlib
import json
import math
import subprocess
import sys
import time

import cv2
import numpy as np

SMALL = (64, 36)            # every frame is shrunk to 64x36 grey for fast comparison
MAX_FRAMES = 30000          # safety limit for very long recordings
MAX_ANALYSIS_SECONDS = 10
REPLAY_FEATURE_SIZE = (16, 9)
MAX_REPLAY_SAMPLES = 1000


# --------------------------------------------------------------------- helpers
def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def ffprobe_info(path):
    """Read optional metadata for callers that do not require a strict time budget."""
    meta = {}
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path],
            capture_output=True, timeout=2, check=True).stdout
        j = json.loads(out)
        fmt = j.get("format", {})
        tags = {k.lower(): v for k, v in fmt.get("tags", {}).items()}
        vs = next((s for s in j.get("streams", []) if s.get("codec_type") == "video"), {})
        meta = {
            "container": fmt.get("format_long_name"),
            "codec": vs.get("codec_name"),
            "bit_rate": fmt.get("bit_rate"),
            "encoder": tags.get("encoder") or vs.get("tags", {}).get("encoder"),
            "creation_time": tags.get("creation_time"),
        }
    except (OSError, subprocess.SubprocessError, ValueError, json.JSONDecodeError):
        pass  # ffprobe not installed or failed: the detector still works without it
    return meta


def runs(mask, min_len):
    """Yield (start, end_inclusive) of consecutive True runs of at least min_len."""
    out, i, n = [], 0, len(mask)
    while i < n:
        if mask[i]:
            j = i
            while j + 1 < n and mask[j + 1]:
                j += 1
            if j - i + 1 >= min_len:
                out.append((i, j))
            i = j + 1
        else:
            i += 1
    return out


def fmt_t(sec):
    sec = max(0.0, float(sec))
    return f"{int(sec // 60):02d}:{sec % 60:05.2f}"


def downsample_max(a, n=1200):
    a = np.asarray(a, dtype=float)
    if len(a) <= n:
        return [round(float(x), 3) for x in a]
    k = math.ceil(len(a) / n)
    pad = (-len(a)) % k
    b = np.pad(a, (0, pad), constant_values=a[-1]).reshape(-1, k).max(1)
    return [round(float(x), 3) for x in b]


# --------------------------------------------------------------------- main
def analyze_video(path, max_frames=MAX_FRAMES, max_seconds=MAX_ANALYSIS_SECONDS):
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise ValueError("That file could not be opened as a video.")
    fps = cap.get(cv2.CAP_PROP_FPS)
    if not fps or fps != fps or fps < 1 or fps > 240:
        fps = 25.0
    width, height = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    frames, replay_frames, cv_ts = [], [], []
    analysis_started_at = time.monotonic()
    time_limit_reached = False
    while len(frames) < max_frames:
        if time.monotonic() - analysis_started_at >= max_seconds:
            time_limit_reached = True
            break
        ok, fr = cap.read()
        if not ok:
            break
        g = cv2.cvtColor(fr, cv2.COLOR_BGR2GRAY) if fr.ndim == 3 else fr
        small = cv2.resize(g, SMALL, interpolation=cv2.INTER_AREA)
        frames.append(small.astype(np.float32))
        replay_frames.append(
            cv2.resize(small, REPLAY_FEATURE_SIZE, interpolation=cv2.INTER_AREA).astype(np.float32)
        )
        cv_ts.append(cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0)
    cap.release()

    n = len(frames)
    if n < 10:
        raise ValueError("The video is too short to analyse (needs at least 10 frames).")

    V = np.stack(frames)                                   # (n, 36, 64)
    flat = V.reshape(n, -1)
    bright = flat.mean(1)
    d = np.zeros(n, dtype=np.float64)                      # mean-squared change vs previous frame
    d[1:] = ((flat[1:] - flat[:-1]) ** 2).mean(1)

    # Sensor-noise floor: typical frame-to-frame change of a quiet scene. Taken from the
    # calmest 20% of frames, ignoring exact repeats (d ~ 0), so busy scenes and frozen
    # segments do not distort it. Motion = clearly above that floor.
    live = d[1:][d[1:] >= 0.02]
    noise_floor = max(float(np.percentile(live, 20)) if len(live) else 0.0, 1e-3)
    thr_motion = max(8 * noise_floor, 0.5)

    ts = np.array(cv_ts)
    ts_src = "opencv"
    duration = float(ts[-1] - ts[0]) if ts[-1] > ts[0] else n / fps

    findings, reasons, score = {}, [], 0

    # 1 ---- timing gaps -----------------------------------------------------
    gaps = []
    dt = np.diff(ts)
    if len(dt) and np.all(np.isfinite(dt)) and np.median(dt) > 0 and ts[-1] > ts[0]:
        exp = float(np.median(dt))
        for i in np.where(dt > 1.8 * exp)[0]:
            lost = int(round(dt[i] / exp)) - 1
            gaps.append({"at": round(float(ts[i]), 2), "at_label": fmt_t(ts[i]),
                         "gap_seconds": round(float(dt[i]), 2), "frames_missing": lost})
    findings["timing_gaps"] = gaps
    if gaps:
        total = sum(g["frames_missing"] for g in gaps)
        reasons.append(f"{len(gaps)} timing gap(s): about {total} frame(s) are missing, first at {gaps[0]['at_label']}.")
        score += min(30, 20 + 5 * (len(gaps) - 1))

    # 2 ---- discontinuities (spike surrounded by calm frames) ----------------
    cuts = []
    for i in range(4, n - 4):
        nb = np.r_[d[i - 3:i], d[i + 1:i + 4]]
        if d[i] > thr_motion * 3 and d[i] > 4 * nb.max() + 0.5:
            cuts.append({"frame": i, "at": round(float(ts[i]), 2), "at_label": fmt_t(ts[i]),
                         "change_strength": round(float(d[i]), 1),
                         "brightness_jump": round(float(bright[i] - bright[i - 1]), 1)})
    # merge neighbours so one cut is reported once
    merged = []
    for c in cuts:
        if merged and c["frame"] - merged[-1]["frame"] <= 2:
            if c["change_strength"] > merged[-1]["change_strength"]:
                merged[-1] = c
        else:
            merged.append(c)
    findings["discontinuities"] = merged
    if merged:
        reasons.append(f"{len(merged)} sudden scene discontinuity(ies), first at {merged[0]['at_label']} "
                       f"(possible cut, splice or removed footage).")
        score += min(30, 25 + 3 * (len(merged) - 1))

    # 3 ---- frozen frames -----------------------------------------------------
    frozen = []
    if noise_floor >= 0.05:                                # only meaningful when real sensor noise exists
        min_run = max(4, int(0.3 * fps))
        pieces = runs(d < 0.1 * noise_floor, 1)
        joined = []                                        # one freeze can flicker: join pieces <=3 frames apart
        for a, b in pieces:
            if joined and a - joined[-1][1] <= 3:
                joined[-1][1] = b
            else:
                joined.append([a, b])
        for a, b in joined:
            # Compressed video repeats identical frames in quiet scenes, which is normal.
            # A suspicious freeze is one where the picture JUMPS when the feed resumes.
            resumes_with_jump = b + 1 < n and d[b + 1:b + 5].max() > 5 * thr_motion
            if b - a + 1 >= min_run and resumes_with_jump:
                frozen.append({"start": round(float(ts[a]), 2), "end": round(float(ts[b]), 2),
                               "start_label": fmt_t(ts[a]), "frames": b - a + 1})
        findings["freeze_check"] = "done"
    else:
        findings["freeze_check"] = "skipped: footage has almost no noise, identical frames are normal"
    findings["frozen_frames"] = frozen
    if frozen:
        tot = sum(f["frames"] for f in frozen)
        reasons.append(f"{len(frozen)} frozen segment(s) ({tot} identical frames), first at "
                       f"{frozen[0]['start_label']} (feed paused or frames duplicated).")
        score += 15

    # 4 ---- replayed / copy-pasted footage -----------------------------------
    replays = []
    step = max(1, math.ceil(n / MAX_REPLAY_SAMPLES))
    S = np.stack(replay_frames)[::step].reshape(-1, REPLAY_FEATURE_SIZE[0] * REPLAY_FEATURE_SIZE[1])
    m = len(S)
    min_lag = max(10, int(2 * fps / step))
    run_len = max(8, int(1.5 * fps / step))
    if m > min_lag + run_len:
        sq = (S ** 2).mean(1)
        M2 = sq[:, None] + sq[None, :] - 2 * (S @ S.T) / S.shape[1]    # mean squared difference
        # Near-identical frames, allowing for re-compression: far below the change between
        # two neighbouring frames of real movement, but above the noise floor.
        busy = d[d > thr_motion]
        typical_motion = float(np.median(busy)) if len(busy) else thr_motion
        thr_match = max(4 * noise_floor + 0.1, 0.1 * typical_motion)
        found = []
        for lag in range(min_lag, m - run_len):
            diag = np.diagonal(M2, lag) < thr_match
            for a, b in runs(diag, run_len):
                lo, hi = a * step, min(n - 1, (b + 1) * step)
                active = float((d[lo:hi + 1] > thr_motion).mean())
                if active >= 0.3:                          # real movement, not just an empty scene
                    found.append((b - a + 1, a, a + lag, lag))
        found.sort(reverse=True)
        used = []
        for length, a, b, lag in found:
            if any(not (a + length < ua or a > ua + ul) for ul, ua in used):
                continue
            used.append((length, a))
            i0, j0 = a * step, b * step
            replays.append({
                "original_start": round(float(ts[i0]), 2), "original_label": fmt_t(ts[i0]),
                "repeated_start": round(float(ts[min(j0, n - 1)]), 2), "repeated_label": fmt_t(ts[min(j0, n - 1)]),
                "length_seconds": round(length * step / fps, 1)})
            if len(used) >= 5:
                break
    findings["replayed_segments"] = replays
    if replays:
        r = replays[0]
        reasons.append(f"{len(replays)} replayed segment(s): footage from {r['original_label']} appears again at "
                       f"{r['repeated_label']} (about {r['length_seconds']} s). This is a strong copy-paste sign.")
        score += 35

    if not reasons:
        reasons.append("No timing gaps, cuts, frozen frames or replayed segments were found.")
        reasons.append("This does not prove the footage is original: careful edits can leave no trace here.")

    # 5 ---- activity events ---------------------------------------------------
    sm = np.convolve(d, np.ones(3) / 3, mode="same")
    ev_mask = sm > thr_motion
    gap_fill = int(fps)                                    # join bursts closer than 1 second
    events, cur = [], None
    for i in range(n):
        if ev_mask[i]:
            if cur and i - cur[1] <= gap_fill:
                cur[1] = i
            else:
                cur = [i, i]
                events.append(cur)
    activity = [{"start": round(float(ts[a]), 2), "end": round(float(ts[b]), 2),
                 "start_label": fmt_t(ts[a]), "end_label": fmt_t(ts[b]),
                 "peak": round(float(d[a:b + 1].max()), 1)} for a, b in events if b - a >= 2]
    findings["activity_events"] = activity

    score = min(100, score)
    verdict = "High risk" if score >= 45 else "Needs review" if score >= 15 else "No tampering indicators found"

    return {
        "verdict": verdict, "risk_score": score, "reasons": reasons,
        "file": {"sha256": sha256_file(path), "frames_analyzed": n, "fps": round(float(fps), 2),
                 "resolution": f"{width}x{height}", "duration_seconds": round(duration, 1),
                 "timestamp_source": ts_src,
                 "truncated": n >= max_frames or time_limit_reached},
        **findings,
        "series": {"change": downsample_max(d), "brightness": downsample_max(bright),
                   "duration_seconds": round(duration, 2), "threshold": round(thr_motion, 3)},
    }


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("Usage: python cctv_detector.py video.mp4")
    res = analyze_video(sys.argv[1])
    res.pop("series")
    print(json.dumps(res, indent=2))
