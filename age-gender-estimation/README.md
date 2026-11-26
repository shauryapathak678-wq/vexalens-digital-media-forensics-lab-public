# VexaLens local apparent-age CLI

This directory is a compatibility CLI only; it reuses the single inference
engine and local model files in `backend`. It does not infer gender, does not
call a cloud provider, and does not download DeepFace weights.

## Setup

From the VexaLens project root, install the same backend dependencies used by
the application:

```powershell
python -m pip install -r backend\requirements.txt
```

OpenCV is constrained to its 4.x release series because the local Caffe models
require OpenCV's Caffe importer. The model setup, source notes, and known
limitations are documented in [backend/AGE_ESTIMATION.md](../backend/AGE_ESTIMATION.md).

## Usage

Run these commands from the VexaLens project root:

```powershell
python age-gender-estimation\age_gender.py --image photo.jpg
python age-gender-estimation\age_gender.py --folder C:\path\to\photos
python age-gender-estimation\age_gender.py --webcam
```

The CLI displays broad apparent-age groups, crop-quality observations, and
face boxes. It does not claim an exact or actual age, and its predictions are
not calibrated for confidence.
