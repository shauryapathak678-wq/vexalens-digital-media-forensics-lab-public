"""Command-line entry point for the Steganography Detector."""

import argparse
import hashlib
import shutil
import sys
from pathlib import Path

from modules.lsb_analysis import analyze_lsb_planes


def sha256_file(path: Path) -> str:
    """Calculate SHA-256 without loading the whole file into memory."""

    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run_lsb_feature(input_file: Path, output_dir: Path) -> int:
    """Copy the evidence, analyze the copy, and print simple LSB ratios."""

    if not input_file.is_file():
        print(f"Error: input file does not exist: {input_file}", file=sys.stderr)
        return 2

    output_dir.mkdir(parents=True, exist_ok=True)
    work_copy = output_dir / f"working_{input_file.name}"
    shutil.copy2(input_file, work_copy)

    before = sha256_file(work_copy)
    result = analyze_lsb_planes(work_copy, output_dir / "lsb_planes")
    after = sha256_file(work_copy)

    print(f"Evidence file: {input_file}")
    print(f"Working copy: {work_copy}")
    print(f"Copy SHA-256 before analysis: {before}")
    print(f"Copy SHA-256 after analysis:  {after}")
    print(f"Copy unchanged: {'YES' if before == after else 'NO'}")
    print()
    print("LSB plane results:")

    for name, channel in result.channels.items():
        ratio = channel.one_ratio
        suspicion = "near 50%" if 0.47 <= ratio <= 0.53 else "not close to 50%"
        print(
            f"  {name.title():5}: {ratio:.4f} "
            f"({channel.ones}/{channel.total} ones, {suspicion})"
        )

    print()
    print("Saved plane images:")
    for name, plane_path in result.plane_paths.items():
        print(f"  {name.title():5}: {plane_path}")
    print(f"  Combined: {result.combined_plane_path}")

    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Steganography Detector - offline digital forensics student tool"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    lsb_parser = subparsers.add_parser(
        "lsb",
        help="Extract and analyze RGB least-significant-bit planes",
    )
    lsb_parser.add_argument("input_file", type=Path, help="PNG or JPEG image")
    lsb_parser.add_argument(
        "--output",
        type=Path,
        default=Path("stego_output"),
        help="Output directory (default: stego_output)",
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if args.command == "lsb":
        return run_lsb_feature(args.input_file, args.output)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
