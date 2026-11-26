# SyncNet audio/video offset analysis

VexaLens integrates the MIT-licensed [`joonson/syncnet_python`](https://github.com/joonson/syncnet_python) implementation at revision `907c0b579c2e2d83f0eae1b2ac9e720cde4e5623`.

The Lip Sync Investigator uses SyncNet to estimate signed audio/video offsets for detected face tracks. It reports offsets only; it does not trim, re-encode, or overwrite evidence. The original implementation converts video to 25 fps and audio to mono 16 kHz, detects/tracks faces, and scores each qualifying track.

## Local setup

1. Initialize the pinned source submodule:

   ```powershell
   git submodule update --init backend/vendor/syncnet_python
   ```

2. Install the backend requirements in the Python environment used by VexaLens:

   ```powershell
   npm run install:backend
   ```

   SyncNet's upstream CPU environment uses Python 3.10. The backend also needs `ffmpeg` and `ffprobe` available on `PATH`.

3. Download the two official pretrained weight files over HTTPS. They are intentionally not committed to this repository:

   ```powershell
   $syncnet = "backend\vendor\syncnet_python"
   New-Item -ItemType Directory -Force "$syncnet\data" | Out-Null
   New-Item -ItemType Directory -Force "$syncnet\detectors\s3fd\weights" | Out-Null
   curl.exe -L --fail "https://www.robots.ox.ac.uk/~vgg/software/lipsync/data/syncnet_v2.model" -o "$syncnet\data\syncnet_v2.model"
   curl.exe -L --fail "https://www.robots.ox.ac.uk/~vgg/software/lipsync/data/sfd_face.pth" -o "$syncnet\detectors\s3fd\weights\sfd_face.pth"
   Get-FileHash "$syncnet\data\syncnet_v2.model" -Algorithm SHA256
   Get-FileHash "$syncnet\detectors\s3fd\weights\sfd_face.pth" -Algorithm SHA256
   ```

   Record the resulting digests in the case or your approved model inventory. The model files are approximately 55 MB and 90 MB; do not commit them.

4. Start the full local stack with `npm run dev`. `npm run dev:frontend` starts only the web app, so the SyncNet health and analysis requests will fail unless the FastAPI backend is started separately. The local backend health endpoint reports missing weights or tools if setup is incomplete.

## Processing and evidence handling

- When the investigator starts analysis, the browser can use a cached `blob:`/`data:` URL, a selected local copy, or download the selected evidence's HTTP(S) preview URL. The preview download is limited to 128 MB; if browser access is blocked by the storage host, select the local copy instead.
- Before analysis, the browser checks the selected bytes against the evidence SHA-256. The local backend independently checks the received bytes against that same digest.
- Input is limited to 128 MB and 60 seconds, and only one SyncNet run is allowed at a time. Videos longer than 5 seconds are reduced to a centered 5-second temporary segment before face detection; shorter videos are analyzed in full. The short window may not contain a face track long enough for an estimate. The result identifies the exact analyzed interval and must not be interpreted as an assessment of the whole longer video.
- Face tracking uses the upstream detector scale of `0.25` and accepts tracks whose average face size is greater than 60 pixels (the upstream default is 100 pixels). This lower size cutoff allows the bundled 480×270 demo clip to produce a real track; it does not fabricate a SyncNet offset. Review the detected track and interpret estimates cautiously, especially for small or low-detail faces.
- SyncNet limits PyTorch and numerical-library CPU thread pools to at most two threads during detection and scoring to reduce CPU oversubscription.
- A transient Python readiness timeout is retried once by the LAB. If SyncNet still appears unavailable, use **Retry readiness check** after confirming the local backend is running.
- Segment extraction creates a temporary local working copy; the original evidence is not changed. The local preprocessing limit is 15 minutes; the UI and proxy allow additional time for upload and response handling.
- Temporary video, segment, frame, and face-track data is written under a temporary directory and removed when analysis finishes.
- SyncNet confidence is a model measure, not a calibrated probability. Its signed offset follows the upstream convention and is expressed at 25 frames per second.
- The hash check verifies byte identity; it does not establish acquisition history or replace write-blocking, chain-of-custody controls, or independent validation.
