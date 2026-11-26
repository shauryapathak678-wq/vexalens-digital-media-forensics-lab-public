# Steganography Detector

This is an offline command-line learning tool for a final-year digital
forensics project. It detects clues, not certainty: steganography analysis can
produce false positives and should be reviewed by an examiner.

## Setup

Use Python 3.10 or newer.

```powershell
cd steganography-detector
py -m venv .venv
.venv\Scripts\Activate.ps1
py -m pip install -r requirements.txt
```

## Feature 1: LSB plane analysis

LSB means Least Significant Bit. Every 8-bit pixel value has a final binary bit
that changes between 0 and 1. For example, 100 is `01100100` and 101 is
`01100101`; only the last bit changed. Steganography tools sometimes replace
this bit with hidden message bits.

Run:

```powershell
py stego.py lsb path\to\image.png --output output\case-001
```

The tool converts the image to RGB, extracts only the final bit of every red,
green, and blue value, and creates:

- `lsb_planes/red_lsb_plane.png`
- `lsb_planes/green_lsb_plane.png`
- `lsb_planes/blue_lsb_plane.png`
- `lsb_planes/rgb_lsb_planes.png`

In each plane, black means LSB 0 and white means LSB 1.

The ratio of 1s near 0.50 is a clue because random or evenly mixed LSB data
often produces close to a 50/50 split. Natural photos can also be close to
50%, and heavily edited or noisy images can mislead this check. Therefore, the
tool reports a ratio only and does not declare a verdict yet.

The input is copied to the output directory before processing. The original
file is never written to by this command.
