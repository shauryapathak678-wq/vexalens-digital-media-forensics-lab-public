#!/usr/bin/env python3
"""
Creates synthetic CCTV test clips (no real people, no real camera data) so you can
demonstrate the detector. Writes into the folder given (default: samples/).

  cctv_clean.mp4     untouched recording
  cctv_removed.mp4   4 seconds of footage cut out (frames re-timed, so timestamps look normal)
  cctv_frozen.mp4    feed freezes for about 3 seconds
  cctv_replay.mp4    a segment of earlier movement is copy-pasted over later footage
  cctv_gap.mp4       frames removed but original timestamps kept (needs ffmpeg)
"""
import os
import shutil
import subprocess
import sys

import cv2
import numpy as np

W, H, FPS, SECONDS = 640, 360, 15, 24
N = FPS * SECONDS


def person_x(t):
    """Two walks across the scene: 3-9 s (left to right) and 14-20 s (right to left)."""
    if 3 <= t < 9:                                   # walks in from off-screen and leaves again
        return int(-60 + (t - 3) / 6 * 760)
    if 14 <= t < 20:
        return int(700 - (t - 14) / 6 * 760)
    return None


def build_frames():
    rng = np.random.default_rng(5)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    base = 95 + 35 * (yy / H) + 12 * np.sin(xx / 70.0)
    base[120:300, 40:140] -= 35                       # a door
    base[200:330, 460:600] -= 25                      # shelves
    base = np.repeat(base[..., None], 3, axis=2) * np.array([0.95, 1.0, 1.05])
    frames = []
    for i in range(N):
        t = i / FPS
        f = base + 14 * np.sin(2 * np.pi * t / 40.0)  # slow light change (clouds)
        px = person_x(t)
        if px is not None:
            cv2.ellipse(f, (px, 250 + int(6 * np.sin(t * 9))), (26, 70), 0, 0, 360, (40, 40, 160), -1)
            cv2.circle(f, (px, 160), 20, (150, 170, 200), -1)
        f = f + rng.normal(0, 3.0, f.shape)           # sensor noise
        f = np.clip(f, 0, 255).astype(np.uint8)
        cv2.putText(f, f"CAM01  2026-11-21 10:00:{int(t):02d}", (12, 26),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1, cv2.LINE_AA)
        frames.append(f)
    return frames


def write(path, frames):
    vw = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"mp4v"), FPS, (W, H))
    for f in frames:
        vw.write(f)
    vw.release()
    print(f"wrote {path}  ({len(frames)} frames, {os.path.getsize(path) / 1e6:.1f} MB)")


def main(out="samples"):
    os.makedirs(out, exist_ok=True)
    clean = build_frames()
    write(f"{out}/cctv_clean.mp4", clean)
    write(f"{out}/cctv_removed.mp4", clean[:270] + clean[330:])   # 18 s - 22 s removed
    write(f"{out}/cctv_frozen.mp4", clean[:100] + [clean[100]] * 45 + clean[145:])
    replay = list(clean)
    replay[250:320] = clean[60:130]
    write(f"{out}/cctv_replay.mp4", replay)
    if shutil.which("ffmpeg"):
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", f"{out}/cctv_clean.mp4", "-vf",
                        "select='not(between(n,270,329))'", "-fps_mode", "passthrough",
                        "-c:v", "mpeg4", "-q:v", "4", f"{out}/cctv_gap.mp4"], check=False)
        print("wrote", f"{out}/cctv_gap.mp4")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "samples")
