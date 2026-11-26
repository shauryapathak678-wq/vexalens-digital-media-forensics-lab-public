"""Least-significant-bit (LSB) plane analysis."""

from dataclasses import dataclass
from pathlib import Path
from typing import Dict

import numpy as np
from PIL import Image


@dataclass(frozen=True)
class LsbChannelResult:
    """Results for one RGB color channel."""

    one_ratio: float
    ones: int
    total: int


@dataclass(frozen=True)
class LsbAnalysisResult:
    """Complete LSB-plane analysis for an image."""

    channels: Dict[str, LsbChannelResult]
    plane_paths: Dict[str, Path]
    combined_plane_path: Path


def analyze_lsb_planes(image_path: Path, output_dir: Path) -> LsbAnalysisResult:
    """Extract and save black/white images of the LSB plane for RGB channels.

    A byte has a least-significant bit (LSB): 0 or 1.  Most natural images
    should not have exactly 50% zeroes and 50% ones in every channel, so a
    ratio near 50% is only a clue.  It is not proof that a message is hidden.
    """

    output_dir.mkdir(parents=True, exist_ok=True)

    with Image.open(image_path) as source:
        rgb = np.asarray(source.convert("RGB"), dtype=np.uint8)

    channel_names = ("red", "green", "blue")
    channels: Dict[str, LsbChannelResult] = {}
    plane_paths: Dict[str, Path] = {}

    for index, name in enumerate(channel_names):
        # The & 1 operation keeps only the final binary bit.
        lsb = rgb[:, :, index] & 1
        ones = int(np.count_nonzero(lsb))
        total = int(lsb.size)
        channels[name] = LsbChannelResult(
            one_ratio=ones / total,
            ones=ones,
            total=total,
        )

        # LSB 1 is white and LSB 0 is black.
        plane_image = Image.fromarray((lsb * 255).astype(np.uint8), mode="L")
        plane_path = output_dir / f"{name}_lsb_plane.png"
        plane_image.save(plane_path)
        plane_paths[name] = plane_path

    # A 1-by-3 contact sheet makes all three planes easy to compare at once.
    planes = [np.asarray(Image.open(path).convert("L")) for path in plane_paths.values()]
    height = max(plane.shape[0] for plane in planes)
    width = max(plane.shape[1] for plane in planes)
    combined = np.concatenate(
        [np.asarray(Image.fromarray(plane).resize((width, height))) for plane in planes],
        axis=1,
    )
    combined_path = output_dir / "rgb_lsb_planes.png"
    Image.fromarray(combined, mode="L").save(combined_path)

    return LsbAnalysisResult(
        channels=channels,
        plane_paths=plane_paths,
        combined_plane_path=combined_path,
    )
