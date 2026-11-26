# Local apparent-age estimation

The VexaLens age-estimation endpoint runs face detection and apparent-age group
classification locally. It does not call an age, gender, or face-analysis API and
requires no external API key.

## Installation and startup

Use Python 3.10 or newer and install the backend dependencies:

```powershell
python -m pip install -r backend\requirements.txt
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

`backend\requirements.txt` constrains `opencv-python-headless` to OpenCV 4.x.
The checked-in Caffe models need the Caffe importer that was removed in OpenCV
5. If a model is missing or cannot load, the API returns an error; it does not
substitute or fabricate a prediction.

The application UI calls the local API through
`POST /api/forensics/age-estimate`. The result records the face model names,
combined SHA-256 model fingerprint, processing timestamp, face boxes, measured
quality observations, and model limitations. Choosing “Record results with this
evidence” stores those observations as a finding linked to that evidence item
and includes it in the case report.

## Models and provenance

- Age groups: the local eight-class Caffe age model, with classes `0-2`,
  `4-6`, `8-12`, `15-20`, `25-32`, `38-43`, `48-53`, and `60-100` years.
  The model is commonly attributed to the Levi–Hassner age classifier trained
  on Adience. The local filenames correspond to the Age Net described in
  [LearnOpenCV's age/gender classification example](https://github.com/spmallick/learnopencv/tree/master/AgeGender),
  which links the weights. This repository does not track the downloaded
  weights' acquisition record or license, so their exact provenance and
  redistribution terms remain unverified.
- Face detection: the local ResNet-10 SSD Caffe model and its `deploy.prototxt`.
  The files' upstream source and license are likewise not recorded here.

The current weight fingerprints are:

- Age model: `6dde5d07df5ca1d66ff39e525693f05ccfb9d2c437e188fdd1a10d42e57fabd6`
- Face detector: `2a56a11a57a4a295956b0660b4a3d76bbdca2206c4961cea8efe7d95c7cb2f2d`

## Interpretation limits

The age model returns only its highest-scoring broad class; its output is not
calibrated and the UI intentionally omits an age-confidence percentage. Results
are approximate apparent-age observations, not actual ages. The included
models do not assess face angle or occlusion. Image-quality rules measure crop
resolution, sharpness, exposure, contrast, and clipped pixels; poor crops are
not sent to the age classifier. These heuristics and the model have not been
validated here across age groups, skin tones, pose, or occlusion. A detector
score is not an identity confidence or a calibrated probability.

Gender is never inferred. The UI offers an optional field for information
explicitly supplied by the subject; it is kept distinct from model output.
