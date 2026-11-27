# VexaLens — Digital Media Forensics Lab and Investigator

**VexaLens** is an educational digital-media examination workbench built with React, TypeScript, Vite, and an Express server. It provides local image, video, audio, metadata, comparison, and report workflows. It is not a validated forensic product, and automated output must not be treated as proof of authenticity or legal conclusions.

---

## 1. System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       VexaLens Presentation Layer                           │
│  React 19 + TypeScript + Tailwind CSS v4                                    │
│  Browser UI and browser-local workspace persistence                         │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                        HTTP REST / JSON API (Port 3000)
                                       │
┌──────────────────────────────────────▼──────────────────────────────────────┐
│                    VexaLens Express Backend (server.ts)                     │
│  - /api/health                : Server/configuration status                 │
│  - /api/forensics/ai-detect   : Honest unavailable response                 │
- /api/forensics/ai-image-origin : Consented third-party image-origin check │
│  - /api/forensics/transcribe  : Optional machine transcription              │
│  - /api/forensics/ai-audio-detect : TruthScan AI audio deepfake screening     │
│  - /api/forensics/ai-audio-credits: TruthScan credit balance check            │
│  - /api/forensics/ai-video-detect : TruthScan AI video job submission         │
│  - /api/forensics/ai-video-query  : TruthScan AI video job status/results      │
│  - /api/forensics/ai-video-credits: Configured video-key credit balance       │
│  - /api/documents/truthscan/*    : Consented TruthScan PDF screening           │
│  - /api/forensics/hash        : SHA-256 over submitted bytes                 │
│  - /api/forensics/cctv/analyze: Local CCTV tamper and activity analysis       │
│  - /api/forensics/origin-analysis : Authorized ExifTool/FFmpeg + Vision flow │
│  - /api/forensics/origin-analysis/status : Non-secret provider status        │
│  - /api/forensics/reverse-media-search : Authorized local + consented search │
│  - /api/documents/analyze     : Authorized DOCX/PDF structure analysis       │
│  - /api/certificates/*        : Optional server HMAC signing/verification    │
│  - /api/reports/sign          : Optional report fingerprint signing          │
│  - /api/reports/verify        : QR-linked report signature check             │
└──────────────────┬───────────────────────────────────┬──────────────────────┘
                   │                                   │
      Optional Google GenAI SDK             Optional Supabase client
   - transcription only                     - Not a complete auth/storage backend
   - no specialist detector                 - Browser storage is not a database
```

### Navigation

The browser experience uses URL-backed navigation: `/` is the landing page, `/information` is the VexaLens mission, team, philosophy, and disclaimer page, `/workspaces` is workspace selection, and `/workspaces/{lab,admin,evidence-room,history-room}` opens the selected workspace. Individual tools have nested workspace URLs, so browser back/forward and refresh retain the current destination. Admin and case-management routes require the administrator role.

---

## 2. Implemented Workflows And Limitations

- **File hashing:** The application has SHA-256 helpers for actual file bytes. A matching hash establishes byte identity, not that depicted content is authentic. Seeded demo records are explicitly marked and contain no calculated hashes.
- **ELA:** Canvas recompresses the image and calculates pixel differences with adjustable display controls. ELA is a recompression diagnostic only; it does not classify manipulation or AI origin.
- **Screenshot Manipulation Detector:** Sends the unchanged JPEG/PNG/WEBP upload to the configured Python backend for OpenCV analysis (25 MB / 12 megapixel limits). It runs JPEG-only, quality-75 ELA; SIFT copy-move feature matching; 32×32 local high-pass residual and boundary-discontinuity measurements; descriptive resampling-periodicity and JPEG-grid measurements; and optional local Tesseract OCR with word boxes and cautious same-line geometry checks. Region coordinates and per-test overlays are derived from those measurements. A numerical fraud probability is not produced: one evidence family alone is inconclusive, and overlapping signals from at least two families prompt manual review. OCR requires a local Tesseract installation (or `TESSERACT_PATH`, with `TESSERACT_CMD` retained as a legacy alias); without it, OCR-related modules report unavailable. Install Python dependencies with `python -m pip install -r backend/requirements.txt`; set `SCREENSHOT_PYTHON_EXECUTABLE` if the server's `python` command is not the desired interpreter. Analysis runs as a bounded, process-local async job (two concurrent jobs; job history is lost if the server restarts). To save analyses to the case database, apply `supabase/migrations/20261016_screenshot_analyses.sql` and sign in to a configured Supabase project. Local analysis needs no third-party detector API key; the optional wasitaigenerated.com AI-origin check separately requires server-side `WIAG_API_KEY` and explicit per-image consent. It transfers the image to that provider and returns a whole-image signal, not localized manipulation evidence. Run `python -m pytest backend/tests/test_screenshot_engine.py` for unit tests and `python -m backend.screenshot_benchmark` for a reproducible eight-image synthetic smoke benchmark. Its precision/recall and false-positive/false-negative rates describe only those generated fixtures, not real-world accuracy; a representative labeled dataset remains necessary for field-performance claims. The tool cannot prove authenticity, alteration, fraud, authorship, or intent.
- **Email Screenshot vs Original Email Verifier:** Saves the unchanged screenshot and original EML/Outlook MSG to the private `evidence` bucket, hashes the original bytes, parses MIME bodies and attachments locally, optionally compares Tesseract OCR text, and stores the result in `email_verifications`. OCR failure does not stop email parsing or hashing. Install local Python requirements with `python -m pip install -r backend/requirements.txt`; MSG parsing uses `extract-msg`. On Windows, install Tesseract with `winget install UB-Mannheim.TesseractOCR` and set `TESSERACT_PATH` to its `tesseract.exe` path (commonly `C:\Program Files\Tesseract-OCR\tesseract.exe`). Link the Supabase project once with `npx supabase link --project-ref <project-ref>`, check pending migrations with `npx supabase migration list --linked`, then apply them from the repository root with `npx supabase db push`. Sign in with a Supabase user before saving evidence and results.
- Email header intelligence includes Received-hop reconstruction and timing, candidate originating IP classification, approximate SPF/DKIM/Return-Path/Reply-To domain alignment, URL/email/IP extraction, and a transparent heuristic risk score. Country enrichment is offline and requires a local GeoLite2 Country database configured with `GEOIP_DATABASE_PATH`; reputation services are never queried automatically and email artifacts are not sent to third parties. The workflow was informed by the feature set of [MailHeaderDetective](https://github.com/akajhon/MailHeaderDetective); its repository contains GPL-3.0 license text despite its README describing the license as MIT, so no source code from it is incorporated here.
- **Metadata:** ExifReader displays available tags. The Evidence Room's image details show embedded EXIF GPS coordinates (including available altitude, capture time, and camera model) on a Leaflet/OpenStreetMap map, with a clear message when location tags are absent. OpenStreetMap is used only to display the pin; it is not queried to detect or resolve the location. Missing or unusual metadata is not a fraud finding.
- **Steganography Detector:** The offline browser tool inspects RGB least-significant bits and implements the uploaded demo's `FSTG1` file format for PNGs: it reads the embedded filename and header, decompresses the payload, optionally asks for the demo password, and verifies the recovered file's SHA-256 before offering a download or inline PDF preview. The bundled demo uses `lab123` for its protected sample; the unprotected sample recovers without a password. It also checks for bytes after PNG `IEND`. A high-risk marker result applies to this format and does not prove that other steganography formats are absent. Password XOR is basic obfuscation, not strong encryption.
- **Document Revision Archaeologist:** The authenticated Lab registers the unchanged DOCX/PDF original in private evidence storage, then the server re-reads it, verifies its SHA-256 against the owner-scoped evidence row, analyzes it locally with `@xmldom/xmldom` and PDF.js, and stores the result in the user-scoped `document_analyses` table. It reports available properties, retained DOCX revisions/comments/relationships/embedded part names, PDF Info/XMP comparisons, page dimensions, raw incremental-update indicators, attachment/form markers, signature markers, annotations on inspected pages, and action indicators. With `TRUTHSCAN_PDF_API_KEY` and explicit per-PDF consent, investigators can separately submit the preserved PDF to TruthScan's PDF detector, select metadata/structure modules and a supported model, poll the saved job, and view the provider result and reported credits deducted. This transfers the original PDF to TruthScan; provider processing may charge credits. The supplied API documentation does not include a PDF credit-balance endpoint; the lab links to the TruthScan account rather than displaying a fabricated or unsupported balance. The History Room can open analyses and download generated reports from private storage. ZIP entries, expanded sizes, XML part sizes, PDF file size, page count, and parse time are bounded. Embedded objects and actions are never opened or executed. Limitations: neither local observations nor the external detector establish authenticity or authorship; PDF revision reconstruction, deleted-content recovery, and cryptographic signature validation are not implemented.
- **Media Origin Intelligence Lab:** Intake accepts signature-checked JPEG, PNG, WebP, TIFF, BMP, MP4, MOV, and WebM evidence through the existing original-preserving evidence workflow. The authenticated server analysis verifies the original SHA-256 against the authorized Supabase evidence row, runs ExifTool where installed, and uses ffprobe/FFmpeg to inspect and sample videos (up to 10 minutes and 1–8 frames). With explicit per-analysis consent and a server-only `GOOGLE_CLOUD_VISION_API_KEY`, the server sends only metadata-stripped, scaled still/frame derivatives to Google Cloud Vision Landmark Detection. The Reverse Media Intelligence panel adds local SHA-256 and perceptual-hash comparison against up to 100 recent user-scoped search records; optionally, after separate explicit consent, it sends only metadata-stripped image or sampled-frame derivatives to Google Cloud Vision Web Detection. It stores results, consent, file hash, and limitations in the user-scoped append-only `reverse_media_searches` table and provides a downloadable PDF report. Web results are public-index observations, not proof of source, date, authorship, authenticity, or full-video identity; local pHash is a visual similarity lead, not a probability. Google landmark results are estimates; returned place coordinates are not embedded capture GPS. OpenStreetMap links are used for returned locations and need no Maps API key. Requests are bounded to 100 MiB, 10 minutes of video, 1–8 frames, and 10 origin-analysis units per investigator per minute on a single server process. There is no background queue, and analysis is investigator-initiated.
- **Image Trace:** Open **Image Trace** from the Media Origin Intelligence Lab or run the FastAPI page directly at `http://127.0.0.1:5000/`. It calculates local SHA-256 and pHash values, creates manual reverse-search links, compares candidate images, and offers official Google Cloud Vision Web Detection, Yandex Image Search API, and TinEye API searches. Bing remains available only as a manual search link. After explicit consent, the browser sends only a canvas-generated, metadata-stripped JPEG (quality 80, long side at most 1024 px); the original stays in the browser. Configured engines run concurrently with independent 30-second deadlines and one retry for network errors or HTTP 5xx. Status, elapsed time, errors, and results stream per engine. Missing credentials show **Not configured**. The full image is searched first; crops are sent only after a successful no-match result and an explicit click on **Deep search**. Local verification checks at most 30 candidates with eight concurrent downloads, each capped at 3 MiB and five seconds. Complete searches with no failed or unconfigured engines are cached in memory by pHash for one hour; incomplete searches are not cached so they can be retried. **Search again** bypasses the cache. Results are labeled by provider match category and platform, ranked social-first, and the optional **Social media only** control can restrict the response. Public indexes are incomplete; private accounts, stories, and unindexed posts are not searched.

  The **Known links scan** accepts up to 20 public post/profile URLs, checks at most 50 image URLs per page, and downloads each candidate with a 10-second limit and a 15 MiB cap. It uses pHash and dHash for the reported similarity and includes an ORB feature-match score as an additional crop/edit clue. gallery-dl runs with default configuration and netrc authentication disabled, in a temporary isolated home, with DNS checks that reject non-public addresses; the scan does not read browser cookies or bypass logins, CAPTCHAs, or rate limits. A login-protected or unsupported page is reported and skipped. The investigator must confirm authorization and enter an authorization note. The note, UTC timestamp, submitted URLs, statuses, and matches are included in the append-only audit record.

  The original upload is not saved. Search engines receive a derivative only after explicit consent; known-link scans send page requests only to the URLs the investigator supplies. Keep `GOOGLE_CLOUD_VISION_API_KEY`, `YANDEX_SEARCH_API_KEY` plus `YANDEX_SEARCH_FOLDER_ID`, and `TINEYE_API_KEY` in server environment variables; never expose them as `VITE_*` values. The local `/api/trace/stream` endpoint streams results; `/api/trace` remains available for single JSON responses. Candidate image downloads are restricted to public HTTP(S) addresses, pinned to resolved addresses, and bounded by redirect, timeout, and size limits. Case hashes, engine statuses, elapsed times, errors, results, and notes are stored in append-only `backend/data/image_trace.sqlite3` (override with `VEXALENS_IMAGE_TRACE_DB`). The additive `engine_details_json` column preserves existing records and the hash chain. The one-hour search cache is process-local and is not shared across server restarts or multiple workers. In the Vercel/Render deployment, these requests run on the Render API service; verify the selected Render plan's request-duration limit before enabling provider calls that can run for 30 seconds. Install dependencies from the repository root with `python -m pip install -r requirements.txt`; start the standalone page and API with `python -m uvicorn backend.main:app --host 127.0.0.1 --port 5000`; run focused tests with `python -m pytest backend/tests/test_image_trace.py`. Limitations: providers may return incomplete results; gallery-dl supports only public pages its extractors understand; “no matches” applies only to engines that completed successfully. Perceptual similarity and ORB matching are indicators, not proof of identity, source, authorship, or authenticity. No face recognition or person identification is performed.
- **Image and video review:** The UI supports previews, comparisons, and browser-based frame handling. Frame differences are descriptive measurements, not manipulation or deepfake classifications.
- **Advanced Forensic Image Comparison Laboratory:** Select images from evidence intake or choose raster files for one-time local analysis (JPEG, PNG, TIFF, WebP, BMP, GIF, or AVIF; 100 MiB per file). OpenCV.js runs locally in the browser for ORB matching, RANSAC homography alignment, Canny edge maps, region extraction, and experimental repeated-feature candidates. Pixel MAE/MSE, changed-pixel counts, block SSIM, pHash/dHash/aHash, channel histograms, high-pass residual distributions, and SHA-256 are reported separately. The viewer supports split, side-by-side, opacity overlay, heatmap, zoom/pan, and fullscreen; reports export locally as PDF/JSON and region CSV. Files are not sent to an image-analysis service, originals are not modified, and working copies are resized to a 1600-pixel longest edge. Results and generated reports are not automatically written to case history. Differences and experimental matches are observations, not proof of manipulation or authenticity.
- **CCTV Tamper & Activity Analysis:** The Video Forensics Lab can analyze a selected local video or one of five synthetic samples. The Express route forwards the unchanged bytes to the local FastAPI service, where OpenCV compares frame timing and pixels for timing gaps, sudden cuts, frozen runs, repeated moving segments, and activity periods. Video uploads are limited to 128 MB and analysis stops after 30,000 frames. A temporary copy is hashed before and after analysis; results are returned only when both hashes and the detector's file hash match. OpenCV is already listed in `backend/requirements.txt`, so this feature adds no Python dependency. Start the local stack with `npm run dev`; use `python -m pytest backend/tests/test_cctv_detector.py` to test the detector and API. Limitations: findings are heuristic indicators, not proof; compression, camera faults, quiet scenes, and periodic motion can create false results or hide edits. `ffprobe` is optional and only improves metadata/timestamp information. The synthetic clips in `public/samples/cctv/` are demonstration data, not a validation dataset.
- **Video Mutation Tree:** The Video Forensics Lab accepts one reference and up to four manually supplied candidate videos (AVI, M4V, MKV, MOV, MP4, or WebM; 128 MiB each and 10 minutes each). The local Python service computes configurable 64-, 256-, or 1024-bit OpenCV DCT hashes about once per second, plus overlapping audio fingerprints when ffprobe/FFmpeg can decode an audio track. It compares ordered samples, clusters likely near-duplicates, and searches the 20 most recently seen compatible fingerprints in the local SQLite database. The reference-rooted similarity tree reports per-edge match strength and measured size/resolution/sharpness ratios. Browser SHA-256 values are checked against temporary copies before and after analysis; hashes, fingerprints, results, and an audit row are stored in ignored `backend/data/video_genealogy.sqlite3`, then temporary media is removed. Install Python dependencies with `python -m pip install -r backend/requirements.txt`; keep FFmpeg and ffprobe on `PATH`. Online discovery is optional and requires a manually entered search phrase plus consent: yt-dlp returns YouTube text-search metadata only, while Google/Bing are ordinary search links. Custom HTTPS links are recorded/displayed but never fetched. No visual hashes, frames, or candidate files are sent online, and candidate videos are never downloaded. The system cannot reliably infer chronological edit direction or prove that similar videos share a source. Public platforms do not offer a common reverse-video perceptual-hash search API; compression, crops, overlays, re-encoding, speed changes, and dubbing can still cause misses or false matches. The 256-bit default is a project-specific OpenCV DCT implementation rather than `videohash`: the preferred fork's declared NumPy/Pillow upper bounds conflict with the versions installed in this workspace, and its single collage hash is less suited to the dense temporal/partial-clip comparisons used here. Use `python -m pytest backend/tests/test_video_genealogy.py` for focused backend coverage.
- **Audio-video timing review:** The investigator can run local Silero VAD v5 on decoded video audio and MediaPipe Face Landmarker on a selected mouth region. It reports speech-like intervals, mouth-landmark coverage, and an approximate correlation/lag; it does not transcribe speech, identify the speaker, guarantee 100% accuracy, or establish manipulation. Sampling is about 10 frames per second and limited to the first 60 seconds. No inference API key is required and media frames are processed in the browser; MediaPipe may transmit product usage or diagnostic metrics. The predev, prebuild, and prestart hooks download the official face-landmarker model when absent (pinned size/SHA-256) and copy the installed WASM, VAD, and ONNX runtime files into ignored `public/models/lipsync/` assets. The optional local SyncNet offset estimator remains separate, analyzes a centered five-second segment (shorter clips are analyzed in full), and may not return an estimate for short or interrupted face tracks. It can use the selected evidence's HTTP(S) preview, a browser-cached Blob, or a local copy; preview downloads start only when analysis is requested, are limited to 128 MB, and are SHA-256 verified before transfer to the local backend.
- **Audio-video synchronization demo:** The same locally bundled 20-second NASA interview clip is used in two browser players; a Web Audio delay node adds a user-adjustable 0–1000 ms delay to the second player's audio without modifying the video file. The waveform and separate video/audio cursors are illustrative playback visualizations. An optional actual SyncNet run analyzes the unchanged bundled clip and is displayed separately from the simulation; a JSON comparison report records the sample SHA-256, analysis status/results, and simulation settings. The clip's source, edit details, NASA media guidance, and no-endorsement notice are in [`public/demo/ATTRIBUTION.txt`](public/demo/ATTRIBUTION.txt); review identifiable-person rights before any commercial or promotional use.
- **Local Model Management (administrator only):** The Admin workspace reads the tracked `models/model_registry.json` manifest and reports local file presence, size, locally computed hashes, published-checksum availability, inference status, license gates, Python/PyTorch/CUDA/OpenCV/ONNX/FFmpeg availability, and hardware compatibility. “Verify” hashes only model files already on disk; a hash is not publisher-authenticated when the source provides no reference digest. “Test inference” runs the bundled sample through the already-installed MediaPipe Face Landmarker in the browser and records the local smoke-test result; it is not a deepfake-classification test. The requested DeepfakeBench, GenConViT, LipForensics, and Self-Blended Images weights are not installed or downloaded by this registry phase. Restricted checkpoints remain blocked under the shared-deployment policy; LipForensics checkpoint rights and MediaPipe model-asset terms require confirmation. Reinstall is disabled until licensing and compatibility are cleared. Model binaries and the per-host `models/metadata/model_status.local.json` status file are excluded from Git; no uploaded evidence is sent to model providers.
- **Audio:** The UI provides local waveform/acoustic measurements and optional Gemini transcription. With `TRUTHSCAN_API_KEY` (or an optional audio-detector key entered in API Key Settings), investigators can explicitly consent to send an audio file for neural voice deepfake screening via TruthScan (`https://detect-audio.truthscan.com`). Checks are evaluated across multi-second temporal speech chunks, reporting AI probability score, chunk-by-chunk breakdowns, and a verdict. Provider processing and retention policies still apply.
- **AI video detection:** With the server-only `TRUTHSCAN_VIDEO_API_KEY`, investigators can explicitly consent to submit a video (MP4, MOV, AVI, MKV, or WebM, up to 100 MB) to TruthScan (`https://detect-video.truthscan.com`) for asynchronous generic or face-swap detection. The browser polls for the job result and displays the credit balance for the configured video key; provider errors are preserved for diagnosis. Provider processing and retention policies apply. Puter is not used for video detection.
- **AI image detection:** The Image Forensics view offers an experimental Puter visual-model opinion using models returned by Puter for Google, OpenAI, and Claude; it requires sign-in and explicit consent. It also offers a local face deepfake scan using the [nikokons EfficientNet-B4 model](https://huggingface.co/nikokons/contrastive-deepfake-detector). The first scan downloads the approximately 141 MB classifier checkpoint and 118 MB RetinaFace detector weights; image analysis then runs locally. This research detector is intended for manipulated faces, analyzes the largest RetinaFace-detected face, and reports an uncalibrated model score. It is not a general AI-image detector, and neither provider's result proves authenticity or origin.
- **DeepSafe image/video frame screening:** NPR Deepfake Detection and UniversalFakeDetect run as separate, preloaded models behind the existing token-protected private sidecar. The API reports each sigmoid-transformed fake-class logit and raw logit independently; higher scores correspond to the fake class in the upstream evaluation labels, but scores are uncalibrated and are not probabilities of image origin. The wrappers calculate sigmoid in double precision from the model logit; very small nonzero values are displayed in scientific notation rather than rounded to `0.0000`, and true floating-point saturation is labeled. VexaLens does not apply the SDK's default 0.5 class field, vote, average, or generate a combined verdict because no threshold has been validated for this use. NPR preprocessing follows its upstream 256 × 256 test resize and ImageNet normalization; UniversalFakeDetect follows its upstream 224 center crop and CLIP normalization. Model source revisions and pretrained checkpoint hashes are pinned in the Dockerfiles. A completed image result is reused only when its evidence SHA-256, DeepSafe revision, and both model versions match; this avoids another original-image Storage download and inference for an identical saved run. Video screening can select 1–3 frames evenly across the already extracted browser frames, submits them in one authenticated request, verifies each SHA-256, and analyzes each independently. It sends selected JPEG derivatives—not the original video—to the private inference service, reuses cached frame data, and performs no Supabase Storage read/write in the frame-analysis route. Frame-level image scores are not a validated video-level verdict; no aggregate video assessment is calculated. Cross-Efficient ViT is present upstream as a video model, but is not integrated here: its wrapper independently extracts 15 frames and runs MTCNN face crops, its manifest does not declare checkpoint hashes, and the current frame-only path would require an adaptation and labeled validation before safe use. No labeled Google Flow or camera-video evaluation set is included, so no accuracy improvement or false-positive/negative rate is claimed. The sidecar still preloads both models and allows up to 90 seconds per model request; failures remain unavailable/failed, never a negative prediction. DeepSafe source revision is `2285e8aaa30b2df0508d570172643d1cae40703f`. The NPR repository's license was not declared at the inspected revision, so public redistribution/deployment is not documented as license-cleared.
- **Beginner and Expert modes:** Beginner Mode is the first-run default and guides case creation, upload, review, and report access. Expert Mode reveals the existing analysis modules.
- **Simple and Detailed reports:** Both use the same saved case/evidence/findings snapshot. Simple reports use a conservative outcome, everyday-language explanations, a quick-reading summary, and a glossary; detailed reports include recorded metadata, methods, observations, and actual stored scores only. English PDF files are generated with jsPDF. Hindi reports use the browser print dialog with native Devanagari font shaping; choose **Save as PDF** there.
- **Evidence Storyboard:** Saved findings are ordered chronologically and link to their associated media. Only recorded evidence, method, limitations, location, and score fields are shown.
- **Batch investigation:** Batch Triage supports multiple files (up to a configurable `MAX_BATCH_FILES` limit). Each file has its own status (pending / completed / failed / cancelled) and result; results can be filtered by type, outcome, and status; a single failed file does not stop the batch. Exact duplicates are detected with SHA-256. **Near-duplicates** are identified with an 8×8 average-hash (aHash) perceptual digest and Hamming distance (threshold 10) and are only labelled when the byte-level SHA-256 digests differ; a perceptually similar pair does not imply a common origin or manipulation.
- **Cross-media case relationships:** The Case Relationships view lists each case's files, the findings and provenance events attached to each file, files with incomplete checks, and simple review prompts where elevated and nominal findings coexist. Every relationship is derived from a recorded user action, file association, or finding; no causal links are inferred.
- **Source & provenance (feature status):** Metadata inspection, SHA-256 hashing, and original-vs-suspect digest comparison run locally. Reverse-image search and C2PA / digital-signature (Content Credentials) verification are **not available** in this build and are shown as unavailable. A lack of a web match or an absent credential is not evidence of forgery.
- **Signature Deception Lab:** Compares saved case images or validated JPEG/PNG/WebP/BMP/TIFF uploads. New uploads are added to the selected investigation and hashed before comparison. The browser provides rotation, region selection, thresholding, overlays, and difference maps; recorded findings link both hashes and the questioned evidence. These exploratory static-image metrics are not a validated identification method and cannot establish signer identity or writing dynamics.
- **Privacy & sharing:** A privacy notice is shown before any external processing, external-processing consent is recorded, and share links are opaque, expiring, access-controlled local references — never public object-storage URLs. Evidence files are not exposed through public URLs by default.
- **Dashboard:** Shows real backend health from `/api/health` (backend API, local browser storage, and specialist AI-origin detector availability), operational counts derived from persisted data, a demo-data banner, and a 5-step beginner workflow. No synthetic uptime or accuracy figures are displayed.
- **Forensic Services Center:** `/api/services` checks backend reachability, a SHA-256 known-answer, configured HMAC round-trip, and separate FFmpeg/ffprobe availability. `/api/health` reports whether the server-only TruthScan video key is configured. The browser separately runs Canvas ELA, PDF output, and a read-only Supabase query when configured. Specialist image, signature, face-match, private storage, and background-worker services report unavailable or not configured rather than operational.
- **Certificates:** Server-side HMAC signing requires `VEXALENS_CERT_SECRET`. The certificate ledger is in memory and is not a durable trust registry; HMAC does not establish signer identity or a public trust chain.
- **Reports:** PDF export is generated from available workspace data. Users can optionally request a server HMAC signature over a structured report fingerprint and include a QR code that opens an online signature check. This authenticates the signed fingerprint, not the PDF bytes; the examiner name is supplied by the local workspace and is not independently identity-checked. Reports remain educational summaries, not official or standards-certified forensic reports.
- **Persistence and Supabase:** Broader application authentication, private evidence storage, and full user-scoped persistence remain incomplete. Authenticated workspace data loads at sign-in and refreshes at most once every five minutes when the browser returns to the app; the client does not poll Supabase in the background. Evidence galleries use stored thumbnails instead of downloading full-resolution originals; originals load only in selected evidence/detail workflows. Signed URLs for evidence are created in batches rather than one request per file.

**Mouth-motion source limitation:** The Lip Sync Investigator reports mouth-track coverage and normalized aperture range, but does not classify movement as natural or AI-generated. Speech activity and face landmarks alone cannot establish how the mouth motion was produced; a validated, authorized classifier is not installed.

---

## 3. Folder Structure

```
├── .env.example                               # Environment variable documentation
├── index.html                                 # HTML5 entry point with JetBrains Mono & Plus Jakarta Sans
├── metadata.json                              # AI Studio capability registry
├── package.json                               # Dependencies and run scripts
├── server.ts                                  # Express API backend & Vite middleware server
├── server/
│   ├── documentAnalysis.ts                   # Bounded DOCX/PDF parsing and evidence rules
│   └── documentAnalysis.test.ts              # DOCX/PDF parser fixtures
├── supabase/
│   └── migrations/
│       ├── 20261015_initial_forensic_schema.sql  # Supabase PostgreSQL schema with RLS
│       ├── 20261024_investigation_intelligence.sql # Legacy migration retained
│       ├── 20261033_document_revision_archaeologist.sql # Document analysis RLS table
│       └── 20261034_truthscan_pdf_detector.sql  # Optional detector job/result columns
└── src/
    ├── main.tsx                               # React root entry point
    ├── App.tsx                                # Main orchestrator with state & navigation
    ├── index.css                              # Tailwind CSS v4 & dark forensics styling
    ├── assets/images/                         # Generated high-resolution forensic sample assets
    ├── types/
    │   ├── forensics.ts                       # Complete TypeScript domain interfaces
    │   └── documentForensics.ts               # Document analysis result types
    ├── lib/
    │   ├── supabase.ts                        # Supabase client, config & connection test
    │   ├── storage.ts                         # Local persistent store & Supabase sync
    │   ├── sampleData.ts                      # Academic demonstration cases & evidence
    │   └── forensics/
    │       ├── crypto.ts                      # SHA-256 hashing & verification
    │       ├── metadata.ts                    # ExifReader extraction & inconsistency audit
    │       ├── ela.ts                         # HTML5 Canvas Error Level Analysis engine
    │       ├── imageForensicAnalysis.ts       # Bounded raster measurements & heatmap layers
    │       ├── perceptualHash.ts              # 8×8 aHash perceptual digest & near-duplicate test
    │       ├── video.ts                       # Video keyframe extractor & frame hashing
    │       ├── audio.ts                       # Web Audio waveform & acoustic dynamics
    │       ├── signatureAnalyzer.ts           # Signature/stamp contour, slant & region analysis
    │       ├── aiOriginDetector.ts            # Local spectral/PRNU AI-origin assessment
    │       ├── analysisEngine.ts              # Domain-separated conclusion builder
    │       ├── reportBuilder.ts               # Simple/Detailed report content (EN/HI) & glossary
    │       ├── reportAuthentication.ts        # Report fingerprint signing & QR verification links
    │       ├── sharing.ts                     # Expiring access-controlled share links & consent
    │       └── pdfExport.ts                   # jsPDF Simple/Detailed report generator
    ├── components/
    │   ├── layout/
    │   │   ├── Header.tsx                     # 3-Zone top bar with case switcher
    │   │   └── Sidebar.tsx                    # Forensics navigation sidebar (mode-aware)
    │   ├── common/
    │   │   ├── SeverityBadge.tsx              # WCAG AA compliant indicator badges
    │   │   └── RegionSelector.tsx             # Drag-to-select signature/stamp region of interest
    │   └── auth/
    │       └── AuthModal.tsx                  # Investigator credentials & role switcher
    └── views/
        ├── LandingView.tsx                    # Lab protocols & demonstration guide
        ├── DashboardView.tsx                  # Forensic Command Center (live health + workflow)
        ├── InvestigationsView.tsx             # Case dossier CRUD & search
        ├── EvidenceUploadView.tsx             # Intake with drag-and-drop & preset samples
        ├── BatchInvestigationView.tsx         # Multi-file batch triage, duplicates & combined report
        ├── ImageForensicsView.tsx             # Interactive ELA canvas & EXIF inspector
        ├── VideoForensicsView.tsx             # Video keyframes & frame hashes
        ├── AudioForensicsView.tsx             # Acoustic waveform & optional transcribe
        ├── AIOriginAssessmentView.tsx         # Puter image assessment and video detection
        ├── DeepfakeDetectorView.tsx           # Honest detector status view
        ├── SignatureCompareView.tsx           # Signature/stamp comparison with region selection
        ├── PhotoToVideoMatchView.tsx          # Cross-media photo-to-video matching
        ├── MediaComparisonView.tsx            # Split slider comparator & metadata matrix
        ├── ProvenanceTimelineView.tsx         # Chain of custody + source-verification status
        ├── CaseRelationshipView.tsx           # Cross-media case relationship view
        ├── FindingsView.tsx                   # Structured findings register + storyboard
        ├── CertificatesView.tsx               # Optional HMAC certificate signing/verification
        ├── ReportsView.tsx                    # Simple/Detailed report preview & export
        ├── DocumentForensicsView.tsx          # Document Revision Archaeologist Lab and report history
        ├── PrivacySharingView.tsx             # Privacy notice, consent & expiring share links
        ├── ForensicServicesView.tsx           # Service/detector availability audit
        ├── AIModelStatusView.tsx              # Detector & model availability status
        ├── BackendProcessingView.tsx          # Server job & processing status
        └── SettingsView.tsx                   # Investigator profile, demo data & Supabase setup
```

---

## 4. Setup & Running the Application

### Prerequisites
- Node.js v22.13 or later (or v24+) for Vite 8 and PDF.js
- npm or yarn
- Python 3.10 or later for local face and apparent-age analysis
- For server extraction: ExifTool and FFmpeg/ffprobe installed on the API server (or set the executable paths below).

### Windows 11
```powershell
Copy-Item .env.example .env
npm install
npm run install:backend
npm run dev
```
`npm run install:backend` installs the local Python dependencies. `npm run dev` starts the FastAPI backend and VexaLens web app together, opening the web app while the backend initializes; it reuses an existing healthy backend if one is already running. Lip-sync runtime assets are reused on subsequent starts when unchanged. `npm run dev:frontend` starts only the web app and requires a separately running backend. If Python is not on `PATH` or the project virtual environment is not used, set `VEXALENS_PYTHON` to the desired Python executable. Open `http://localhost:3000`. Run `npm test`, `npm run lint`, and `npm run build` to validate the workspace. The app does not need API credentials for its local hash, metadata, ELA, or age-estimation workflows. Set `GEMINI_API_KEY` for optional transcription, `TRUTHSCAN_API_KEY` for external audio screening, and `TRUTHSCAN_VIDEO_API_KEY` for external video detection. External media submissions each require per-file consent. TruthScan keys are used only by the server.

To enable Media Origin Intelligence server analysis, apply all Supabase migrations (including `20261115010000_reverse_media_searches.sql`) and sign in as the owner of the evidence. Install ExifTool and FFmpeg on the machine running `server.ts`; verify with `exiftool -ver`, `ffprobe -version`, and `ffmpeg -version`. On Windows, download ExifTool from [exiftool.org](https://exiftool.org/) and a trusted FFmpeg build; either add the executables to `PATH` or set their absolute paths in the server's ignored `.env`. Local reverse fingerprints run on the configured VexaLens backend. Public Web Detection requires the same server-only `GOOGLE_CLOUD_VISION_API_KEY` and a separate per-search consent checkbox; do not check it unless external processing is authorized. Review current Google Cloud Vision pricing and quotas before use because Web Detection requests may incur charges. The original evidence is not sent to Google.

To run the optional DeepSafe image sidecar locally, install Docker Desktop and start its Linux container engine. Generate one shared token with `python -c "import secrets; print(secrets.token_urlsafe(48))"`, put it in `DEEPSAFE_IMAGE_SERVICE_TOKEN` in both the root `.env` and `deepsafe-inference\.env`, then run `docker compose --env-file deepsafe-inference\.env -f deepsafe-inference\docker-compose.yml up --build -d` from the repository root. The compose file pins DeepSafe to the revision above, exposes only the token-protected proxy on loopback (`127.0.0.1:8010` by default), and keeps both model endpoints on an internal network; the proxy also joins a separate bridge so Docker Desktop can publish its loopback port. Set the root `.env` `DEEPSAFE_IMAGE_SERVICE_URL` to `http://127.0.0.1:8010` when Express runs on the same host. For remote deployments, connect Express and the sidecar over private networking, set the URL to that private endpoint, and do not publish model or proxy ports publicly. First startup downloads model weights and preloads both models; startup duration varies and analysis should only be run after both report `loaded`. Once warm, the two model requests run concurrently with a 90-second timeout each; the API allows up to 100 seconds for the sidecar and the browser allows 110 seconds. A timeout is reported as an unavailable model, not as a negative prediction. Apply the database changes with `npx supabase db push` after linking the intended Supabase project, and sign in before uploading/analyzing case evidence. Check availability from the lab UI; model health alone does not demonstrate a successful prediction. The NPR model's redistribution/deployment license remains unclear, so resolve that before public deployment. CPU inference is memory intensive; defaults cap NPR at 1.5 GiB and UFD at 4 GiB to leave room for Docker and the sidecar on an 8 GiB Docker engine. Increase those caps only on a host with sufficient memory.

After changing only the inference timeout, restart the VexaLens server and rebuild just the proxy API with `docker compose --env-file deepsafe-inference\.env -f deepsafe-inference\docker-compose.yml up -d --no-deps --build vexalens-deepsafe-image`. Leave the two model containers running so their large model weights are not downloaded again.

The Document Revision Archaeologist also requires Supabase Auth, the private `evidence` bucket, and all migrations (including `20261033_document_revision_archaeologist.sql` and `20261034_truthscan_pdf_detector.sql`) applied. If analysis history reports that `public.document_analyses` is missing, apply the migrations in the Supabase SQL Editor and refresh the app; the migrations request a PostgREST schema-cache reload. Sign in with Supabase before uploading or viewing private history. It accepts `.docx` and `.pdf` evidence up to 20 MiB by default, analyzes the stored original on the local VexaLens server, and stores results/reports under the authenticated owner. PDF analysis inspects at most 50 pages by default and scans raw indicators for embedded files/forms instead of forcing PDF.js to index every object; larger files are marked partially analyzed. Optional TruthScan screening requires `TRUTHSCAN_PDF_API_KEY` in the server `.env`, is never enabled by default, and requires per-analysis consent because it transfers the original PDF to an external provider and may consume credits. Supabase administrators can replace the token from the PDF detector panel; that runtime replacement is memory-only and resets when the server restarts, so environment configuration is preferred for deployments. The UI shows only a masked saved token; the full token is never returned to the browser. The UI displays credits deducted when TruthScan reports them; no PDF balance endpoint is documented. Configure the optional server limits in `.env`; do not increase them without reviewing available server memory and CPU.

For optional landmark detection, create/select a Google Cloud project, enable [Cloud Vision API](https://console.cloud.google.com/apis/enableflow?apiid=vision.googleapis.com), and enable billing. Create an API key, restrict it to the Cloud Vision API and (for deployed servers) the server's IP address; do not use browser/referrer restrictions for this server-side key. Store it only as `GOOGLE_CLOUD_VISION_API_KEY` in `.env`, then restart the API server. Never paste it into the UI, source code, or a committed file. Cloud Vision only receives a derivative when the investigator checks the consent box and starts analysis. Google pricing currently lists the first 1,000 Landmark Detection units per month as free and then $1.50 per 1,000 units through the next tier; pricing, quotas, and eligibility can change, so verify the [current pricing](https://cloud.google.com/vision/pricing) and set project quotas/budget alerts. Every still image or sampled video frame can incur a separate feature unit. The server uses a 7 MiB inline payload ceiling and reports when it cannot create a compliant derivative; the original evidence is never resized or rewritten.

Google Maps Platform is not used by this feature; no Maps API key is needed. The UI links coordinates to OpenStreetMap. The report and UI identify API scores as provider-returned scores, not calibrated confidence.

---

## 5. Environment Variables & Secrets

Configure the following variables in `.env` (refer to `.env.example`):

| Variable | Description |
|---|---|
| `GEMINI_API_KEY` | Optional server-side key for supported Gemini workflows. A configured key does not provide a specialist image or video authenticity detector. |
| `GEMINI_TRANSCRIPTION_MODEL` | Optional transcription model name; defaults to `gemini-2.5-flash`. |
| `TRUTHSCAN_API_KEY` | Optional server-only credential for external audio screening via TruthScan (`https://detect-audio.truthscan.com`). The UI requires per-file consent. |
| `TRUTHSCAN_VIDEO_API_KEY` | Optional server-only credential for external video detection via TruthScan (`https://detect-video.truthscan.com`). The UI requires per-file consent; never expose it in browser settings or a `VITE_*` variable. |
| `TRUTHSCAN_PDF_API_KEY` | Optional server-only credential for external PDF detection via TruthScan (`https://detect-pdf.truthscan.com`). The original PDF is sent only after per-analysis consent; results report any credits deducted. Never expose it in browser settings or a `VITE_*` variable. |
| `DEEPSAFE_IMAGE_SERVICE_URL` | Optional private URL for the token-protected DeepSafe sidecar; defaults to unavailable. Use loopback for the documented same-host Compose setup. |
| `DEEPSAFE_IMAGE_SERVICE_TOKEN` | Required shared secret when DeepSafe is enabled; configure the same random value in the root `.env` and `deepsafe-inference/.env`. Never expose it as a `VITE_*` variable. |
| `DEEPSAFE_IMAGE_TIMEOUT_MS` | Optional VexaLens-to-sidecar timeout; defaults to and is capped at `100000` milliseconds. |
| `GOOGLE_CLOUD_VISION_API_KEY` | Optional server-only API key for Google Cloud Vision Landmark Detection and consented Web Detection searches. Requires Cloud Vision API enablement, suitable quotas, and explicit investigator consent for each operation; provider charges may apply. Never expose as a `VITE_*` variable. |
| `EXIFTOOL_PATH` | Optional absolute path to ExifTool; defaults to `exiftool` on server `PATH`. |
| `FFMPEG_PATH` | Optional absolute path to FFmpeg; defaults to `ffmpeg` on server `PATH`. |
| `FFPROBE_PATH` | Optional absolute path to ffprobe; defaults to `ffprobe` on server `PATH`. |
| `VEXALENS_CERT_SECRET` | Required server-only secret for HMAC certificate and report signing. Without it, signing and verification are unavailable. |
| `VITE_SUPABASE_URL` | *(Optional)* Supabase project URL (e.g. `https://your-project.supabase.co`). |
| `VITE_SUPABASE_ANON_KEY` | *(Optional)* Supabase anonymous API key for client authentication and database sync. |
| `PORT` | Web server port (defaults to `3000`). |
| `VEXALENS_API_URL` | Optional backend URL used by Vite dev/preview proxies; defaults to `http://127.0.0.1:3000`. |
| `VEXALENS_PYTHON_API_URL` | FastAPI service URL used by the Express API; defaults to `http://127.0.0.1:8000`. |
| `DOCUMENT_ANALYSIS_MAX_BYTES` | Optional server-side DOCX/PDF byte limit; defaults to `20971520` (20 MiB). |
| `DOCUMENT_ANALYSIS_MAX_PDF_PAGES` | Optional maximum PDF pages inspected; defaults to `50`. Larger PDFs are marked partially analyzed. |
| `DOCUMENT_ANALYSIS_TIMEOUT_MS` | Optional PDF parser processing timeout; defaults to `30000` milliseconds. |
| `VITE_DOCUMENT_ANALYSIS_MAX_BYTES` | Optional client-side upload-limit display; server limit remains authoritative. |

> **Note**: Without Supabase, this project uses browser-local persistence; this is suitable for a local demonstration, not a production database. English reports download as PDFs. Hindi reports open a print-ready browser page; choose **Save as PDF** in the print dialog so the browser can shape Devanagari text with its installed fonts.

For report signing in a Vite preview, run the VexaLens API server with `npm run dev` and ensure `VEXALENS_API_URL` points to that server (default `http://127.0.0.1:3000`). Vite forwards `/api` requests to it. Configure `VEXALENS_CERT_SECRET` on that API server and restart it after changing code or environment values.

### Vercel and Render deployment

The Vite frontend is deployed on Vercel. Its `/api/*` requests are rewritten to the Render Express service, which proxies Python analysis requests to the separate FastAPI service. Configure the Express service with `NODE_ENV=production` and `VEXALENS_PYTHON_API_URL` set to the FastAPI service URL. Build the Render Express service with `npm ci && npm run build` and start it with `npm start`; Vercel builds with `npm run build` and publishes `dist`. Optional provider credentials must be configured as server-side environment variables on Render, never as `VITE_*` variables.

Create `.env` from `.env.example` and configure `VEXALENS_CERT_SECRET` with a cryptographically random 32-byte hex value. For example, generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Keep `.env` local; rotate any API key that was previously committed or shared.

---

## 6. Supabase Status

The repository includes Supabase schema and compatibility migrations. Apply every SQL file in `supabase/migrations` in filename order in the Supabase SQL Editor. The compatibility migrations synchronize legacy ownership columns, standardize investigation statuses, and remove an empty app-generated placeholder case while preserving any case that has evidence attached. With Supabase configured, signed-in case lists are loaded from PostgreSQL as the shared source of truth; case creation is only shown as successful after the database confirms it.

When configured and signed in, the app uploads evidence files to Supabase Storage and stores their metadata in PostgreSQL. Database RLS and Storage policies must be enabled and applied for the project; an application build alone does not apply migrations to the live database. Use only the publishable/anon key in the browser. Never place a Supabase secret/service-role key in browser code or commit one; rotate keys that were shared in chat.

---

## 7. College Demonstration Walkthrough

For an interface walkthrough, choose **Reset Data to Factory Demonstration State** in Settings. The application displays a demo-data warning while seeded data is loaded. Use an uploaded file to demonstrate hashing, metadata inspection, ELA visualization, comparison, and PDF export. Do not present seeded findings, provenance events, hashes, or certificates as actual examinations. The specialist image-origin detector and server certificate signing remain unavailable unless their stated prerequisites are configured; video detection requires the TruthScan key.

Novel workflow to demonstrate (all available locally, no credentials required):

1. **Create an investigation** on the Dashboard (Beginner Mode shows a 5-step workflow).
2. **Upload evidence** — one file or a batch of six or more.
3. In **Batch Triage**, show per-file status, filter by type/outcome/status, and the exact-duplicate (SHA-256) and near-duplicate (aHash) columns, then export a combined report.
4. Open **Findings** to walk the chronological Evidence Storyboard and click a finding to jump to its evidence.
5. Open **Case Relationships** to show which files, findings, and provenance events belong to the case and which checks are incomplete.
6. In **Signature Compare**, switch to Stamp/Seal mode, drag a region of interest, and save the measurable comparison as a finding.
7. Open **Privacy & Sharing** to show the privacy notice, record external-processing consent, and create an expiring, access-controlled share link.
8. Generate the **Simple Report** (English PDF) and the **Detailed Forensic Report**, then switch to Hindi to show the print-ready Devanagari output.

For a labelled test dataset, use the bundled sample assets plus a known byte-identical copy of one file (to trigger exact-duplicate detection) and a resized/re-compressed copy (to trigger near-duplicate detection). Files that are byte-identical share the same SHA-256; a different hash does not by itself indicate manipulation.

---

## 8. Feature Status Summary

**Genuinely working locally (no credentials required):** SHA-256 hashing and verification; ExifReader metadata inspection; Canvas ELA; video keyframe extraction and frame hashing; CCTV frame-tamper indicators and activity timeline; Web Audio measurements; perceptual near-duplicate detection; RegionSelector-based signature/stamp comparison; domain-separated conclusion engine; Simple and Detailed report content builder; English PDF export via jsPDF; Hindi print-ready report; Evidence Storyboard; Batch triage with per-file status and combined report; Case Relationship view; dashboard live health and operational counts; expiring access-controlled share links; audit/activity logging; in-memory HMAC certificate signing when `VEXALENS_CERT_SECRET` is set.

**Dependent on external services or configuration:** Supabase-based authentication, private evidence storage, and user-scoped persistence (requires `VITE_SUPABASE_URL` + `VITE_SUPABASE_PUBLISHABLE_KEY` and applying all migrations, including the private `evidence` bucket migration; users must sign in before uploading. Evidence uploads save the original file to Supabase Storage and its metadata to PostgreSQL, and report a failure instead of claiming success if either write fails); DeepSafe image analysis and saved history (requires Docker-hosted NPR and UniversalFakeDetect services, the private sidecar/token, Supabase evidence access, and migration `20261114010000_deepsafe_image_detection.sql`); Document Revision Archaeologist analysis and report archive (requires Supabase authorization, private evidence storage, and the document-analysis migration; parsing runs locally on the configured VexaLens server); Media Origin server metadata/frame analysis (requires Supabase authorization and installed ExifTool/FFmpeg/ffprobe); optional Google Cloud Vision landmark detection (requires `GOOGLE_CLOUD_VISION_API_KEY`; provider consent is requested per analysis and provider quotas/billing apply); optional Gemini audio transcription (requires `GEMINI_API_KEY`; unavailable without it); server-side HMAC certificate signing (requires `VEXALENS_CERT_SECRET`).

**Intentionally unavailable / incomplete:** no validated specialist AI image-origin detector — `/api/forensics/ai-detect` reports `detection_unavailable`; video detection requires a configured TruthScan credential; reverse Web Detection covers only Google-indexed matches and is not an exhaustive Internet search; no C2PA / Content Credentials verification; no OCR engine; no production background job queue; Hindi reports render through the browser print pipeline rather than direct jsPDF Devanagari embedding. These states are shown honestly in the UI rather than faked.

---

## 9. Standards & Scientific Limitations

- Missing metadata, ELA, and frame-difference measurements are not proof of manipulation or synthetic origin.
- This educational application does not claim conformance with NIST SP 800-86 or ISO/IEC 27037. Those standards may inform a human examiner's workflow but have not been independently validated here.

## GPS Image Tracker (standalone demo)

This local Flask page reads GPS coordinates only from an uploaded image's EXIF metadata, using Pillow. It does not use a location-detection API. Leaflet and OpenStreetMap tiles display the map pin only; the map link is also just a display link. The photo is held in memory and in a temporary file only while it is processed, and the temporary file is deleted afterward.

### Setup and run

From the repository root, create and activate a Python 3.10+ virtual environment, then install the project requirements:

```powershell
python -m venv venv
.\venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python app.py
```

The root `requirements.txt` also includes this repository's existing backend requirements. To install only what the standalone tracker needs, use `python -m pip install Flask Pillow pillow-heif` instead.

Open [http://127.0.0.1:5000](http://127.0.0.1:5000). To test coordinate conversion and missing/corrupt-image handling, run `python -m unittest test_gps_tracker`.

Photos may have no GPS tag because the camera's location setting was off, or because an app removed metadata when sharing or editing the image. WhatsApp, Instagram, and screenshots commonly strip location data. For the Janeshwar Mishra Park demo, take test photos with the phone camera's location setting turned on and upload the original file, not a compressed copy sent over a messaging app.
