"""Local SyncNet inference adapter for audio/video offset estimation."""

import importlib
from importlib.util import find_spec
from contextlib import contextmanager
import logging
import math
import os
import pickle
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Iterator


LOGGER = logging.getLogger(__name__)
UPSTREAM_REVISION = "907c0b579c2e2d83f0eae1b2ac9e720cde4e5623"
FRAME_RATE = 25
MAX_VIDEO_DURATION_SECONDS = 60
ANALYSIS_WINDOW_SECONDS = 5
SYNCNET_CPU_THREADS = min(2, os.cpu_count() or 1)
FACE_DETECTION_SCALE = 0.25
MIN_FACE_SIZE_PIXELS = 60
PIPELINE_TIMEOUT_SECONDS = 900
SEGMENT_EXTRACTION_TIMEOUT_SECONDS = 120

_DEFAULT_REPOSITORY = Path(__file__).resolve().parent / "vendor" / "syncnet_python"
_SYNCNET_REPOSITORY = Path(os.environ.get("SYNCNET_REPO_PATH", str(_DEFAULT_REPOSITORY))).expanduser().resolve()
_SYNCNET_MODEL = Path(os.environ.get(
    "SYNCNET_MODEL_PATH",
    str(_SYNCNET_REPOSITORY / "data" / "syncnet_v2.model"),
)).expanduser().resolve()
_S3FD_WEIGHTS = _SYNCNET_REPOSITORY / "detectors" / "s3fd" / "weights" / "sfd_face.pth"
_REQUIRED_DEPENDENCIES = {
    "NumPy": "numpy",
    "OpenCV": "cv2",
    "PyTorch": "torch",
    "SciPy": "scipy",
    "PySceneDetect": "scenedetect",
    "python_speech_features": "python_speech_features",
    "tqdm": "tqdm",
}

_ANALYSIS_LOCK = threading.Lock()
_MODEL: Any = None
_LOADED_MODEL_PATH: Path | None = None


class SyncNetNotConfiguredError(RuntimeError):
    pass


class SyncNetInputError(ValueError):
    pass


class SyncNetInferenceError(RuntimeError):
    pass


@contextmanager
def _syncnet_cpu_thread_limit(torch: Any) -> Iterator[None]:
    if torch.cuda.is_available():
        yield
        return

    previous_threads = torch.get_num_threads()
    try:
        torch.set_num_threads(SYNCNET_CPU_THREADS)
        yield
    finally:
        torch.set_num_threads(previous_threads)


def get_syncnet_status() -> dict[str, Any]:
    required = {
        "SyncNet repository": _SYNCNET_REPOSITORY / "run_pipeline.py",
        "SyncNet pretrained model": _SYNCNET_MODEL,
        "S3FD face detector weights": _S3FD_WEIGHTS,
    }
    missing = [label for label, path in required.items() if not path.is_file()]
    missing_dependencies = [
        label for label, module in _REQUIRED_DEPENDENCIES.items()
        if find_spec(module) is None
    ]
    missing_tools = [name for name in ("ffmpeg", "ffprobe") if shutil.which(name) is None]
    return {
        "configured": not missing and not missing_dependencies and not missing_tools,
        "upstream": "joonson/syncnet_python",
        "upstream_revision": UPSTREAM_REVISION,
        "missing_files": missing,
        "missing_dependencies": missing_dependencies,
        "missing_tools": missing_tools,
        "max_video_duration_seconds": MAX_VIDEO_DURATION_SECONDS,
        "max_video_bytes": 128 * 1024 * 1024,
        "analysis_window_seconds": ANALYSIS_WINDOW_SECONDS,
    }


def _require_syncnet() -> None:
    status = get_syncnet_status()
    if not status["configured"]:
        details = status["missing_files"] + status["missing_dependencies"] + status["missing_tools"]
        raise SyncNetNotConfiguredError(
            "The local SyncNet service is not configured. Missing: " + ", ".join(details)
        )


def _probe_duration(video_path: Path) -> float:
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                str(video_path),
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=15,
        )
        duration = float(result.stdout.strip())
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        raise SyncNetInputError("The uploaded file could not be probed as a supported video.") from exc

    if not 0 < duration <= MAX_VIDEO_DURATION_SECONDS:
        raise SyncNetInputError(
            f"Video duration must be greater than zero and no more than {MAX_VIDEO_DURATION_SECONDS} seconds."
        )
    return duration


def _select_analysis_window(duration_seconds: float) -> tuple[float, float]:
    if not math.isfinite(duration_seconds) or duration_seconds <= 0:
        raise SyncNetInputError("Video duration must be a positive, finite value.")
    window_duration = min(duration_seconds, ANALYSIS_WINDOW_SECONDS)
    window_start = (duration_seconds - window_duration) / 2
    return window_start, window_duration


def _extract_analysis_window(
    video_path: Path,
    output_path: Path,
    start_seconds: float,
    duration_seconds: float,
) -> None:
    try:
        subprocess.run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel", "error",
                "-ss", f"{start_seconds:.6f}",
                "-i", str(video_path),
                "-t", f"{duration_seconds:.6f}",
                "-map", "0:v:0",
                "-map", "0:a:0?",
                "-c:v", "libx264",
                "-preset", "ultrafast",
                "-crf", "18",
                "-pix_fmt", "yuv420p",
                "-c:a", "aac",
                "-b:a", "128k",
                "-movflags", "+faststart",
                "-y", str(output_path),
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=SEGMENT_EXTRACTION_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as exc:
        raise SyncNetInferenceError("Creating the 5-second SyncNet analysis segment timed out.") from exc
    except (OSError, subprocess.CalledProcessError) as exc:
        LOGGER.exception("Could not create the temporary SyncNet analysis segment.")
        raise SyncNetInferenceError("Could not create the temporary SyncNet analysis segment.") from exc
    if not output_path.is_file() or output_path.stat().st_size == 0:
        raise SyncNetInferenceError("FFmpeg produced an empty SyncNet analysis segment.")


def _get_model() -> Any:
    global _MODEL, _LOADED_MODEL_PATH
    if _MODEL is not None and _LOADED_MODEL_PATH == _SYNCNET_MODEL:
        return _MODEL

    repository_path = str(_SYNCNET_REPOSITORY)
    if repository_path not in sys.path:
        sys.path.insert(0, repository_path)

    instance_module_path = (_SYNCNET_REPOSITORY / "SyncNetInstance.py").resolve()
    existing_module = sys.modules.get("SyncNetInstance")
    if existing_module and Path(existing_module.__file__).resolve() != instance_module_path:
        sys.modules.pop("SyncNetInstance", None)
        sys.modules.pop("SyncNetModel", None)

    try:
        instance_module = importlib.import_module("SyncNetInstance")
        model = instance_module.SyncNetInstance()
        model.loadParameters(str(_SYNCNET_MODEL))
    except Exception as exc:
        LOGGER.exception("Could not initialize the configured SyncNet model.")
        raise SyncNetInferenceError("SyncNet model initialization failed; check the configured model and dependencies.") from exc

    _MODEL = model
    _LOADED_MODEL_PATH = _SYNCNET_MODEL
    return model


def analyze_syncnet_video(video_path: Path) -> dict[str, Any]:
    _require_syncnet()
    duration_seconds = _probe_duration(video_path)
    segment_start_seconds, segment_duration_seconds = _select_analysis_window(duration_seconds)
    segment_end_seconds = segment_start_seconds + segment_duration_seconds
    started_at = time.monotonic()

    with _ANALYSIS_LOCK:
        try:
            with tempfile.TemporaryDirectory(prefix="vexalens_syncnet_") as temporary_directory:
                work_path = Path(temporary_directory)
                analysis_path = video_path
                if duration_seconds > ANALYSIS_WINDOW_SECONDS:
                    analysis_path = work_path / "analysis_segment.mp4"
                    _extract_analysis_window(
                        video_path,
                        analysis_path,
                        segment_start_seconds,
                        segment_duration_seconds,
                    )
                reference = uuid.uuid4().hex
                command = [
                    sys.executable,
                    str(_SYNCNET_REPOSITORY / "run_pipeline.py"),
                    "--videofile", str(analysis_path),
                    "--reference", reference,
                    "--data_dir", str(work_path / "work"),
                    "--facedet_scale", str(FACE_DETECTION_SCALE),
                    "--min_face_size", str(MIN_FACE_SIZE_PIXELS),
                    "--overwrite",
                ]
                pipeline_environment = os.environ.copy()
                for variable in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
                    pipeline_environment[variable] = str(SYNCNET_CPU_THREADS)
                subprocess.run(
                    command,
                    cwd=str(_SYNCNET_REPOSITORY),
                    env=pipeline_environment,
                    check=True,
                    capture_output=True,
                    text=True,
                    timeout=PIPELINE_TIMEOUT_SECONDS,
                )

                track_directory = work_path / "work" / "pycrop" / reference
                crop_paths = sorted(track_directory.glob("*.avi"))
                if not crop_paths:
                    return {
                        "status": "completed",
                        "model": "SyncNet",
                        "model_version": "syncnet_v2",
                        "upstream_revision": UPSTREAM_REVISION,
                        "video_duration_seconds": round(duration_seconds, 3),
                        "analysis_segment_start_seconds": round(segment_start_seconds, 3),
                        "analysis_segment_end_seconds": round(segment_end_seconds, 3),
                        "analysis_segment_duration_seconds": round(segment_duration_seconds, 3),
                        "frame_rate": FRAME_RATE,
                        "face_detection_scale": FACE_DETECTION_SCALE,
                        "min_face_size_pixels": MIN_FACE_SIZE_PIXELS,
                        "analysis_duration_seconds": round(time.monotonic() - started_at, 3),
                        "tracks": [],
                        "message": "No face track met SyncNet's minimum duration and detection requirements.",
                    }

                tracks_path = work_path / "work" / "pywork" / reference / "tracks.pckl"
                with tracks_path.open("rb") as track_file:
                    face_tracks = pickle.load(track_file, encoding="latin1")

                torch = importlib.import_module("torch")
                model = _get_model()
                options = SimpleNamespace(
                    tmp_dir=str(work_path / "inference_tmp"),
                    reference="",
                    batch_size=20,
                    vshift=15,
                )
                results = []
                with _syncnet_cpu_thread_limit(torch), torch.inference_mode():
                    for track_index, crop_path in enumerate(crop_paths):
                        options.reference = f"{reference}_{track_index}"
                        offset, confidence, _distances = model.evaluate(options, str(crop_path))
                        track_data = face_tracks[track_index].get("track", {})
                        frame_count = len(track_data.get("frame", []))
                        offset_frames = int(offset.item() if hasattr(offset, "item") else offset)
                        confidence_score = float(confidence.item() if hasattr(confidence, "item") else confidence)
                        if not math.isfinite(confidence_score):
                            raise SyncNetInferenceError("SyncNet returned a non-finite confidence measure.")
                        results.append({
                            "track_index": track_index,
                            "face_track_frames": frame_count,
                            "face_track_duration_seconds": round(frame_count / FRAME_RATE, 3),
                            "offset_frames": offset_frames,
                            "offset_seconds": round(offset_frames / FRAME_RATE, 4),
                            "confidence_score": round(confidence_score, 6),
                        })
        except SyncNetInputError:
            raise
        except subprocess.TimeoutExpired as exc:
            raise SyncNetInferenceError("SyncNet preprocessing exceeded the 15-minute processing limit.") from exc
        except subprocess.CalledProcessError as exc:
            LOGGER.error("SyncNet face pipeline failed with exit code %s.", exc.returncode)
            raise SyncNetInferenceError("SyncNet face detection or tracking failed. Check FFmpeg and S3FD setup.") from exc
        except SyncNetInferenceError:
            raise
        except Exception as exc:
            LOGGER.exception("SyncNet analysis failed.")
            raise SyncNetInferenceError("SyncNet could not complete this analysis.") from exc

    return {
        "status": "completed",
        "model": "SyncNet",
        "model_version": "syncnet_v2",
        "upstream_revision": UPSTREAM_REVISION,
        "video_duration_seconds": round(duration_seconds, 3),
        "analysis_segment_start_seconds": round(segment_start_seconds, 3),
        "analysis_segment_end_seconds": round(segment_end_seconds, 3),
        "analysis_segment_duration_seconds": round(segment_duration_seconds, 3),
        "frame_rate": FRAME_RATE,
        "face_detection_scale": FACE_DETECTION_SCALE,
        "min_face_size_pixels": MIN_FACE_SIZE_PIXELS,
        "confidence_semantics": "SyncNet confidence measure; not a calibrated probability.",
        "offset_semantics": "Signed offset in SyncNet's upstream frame convention at 25 frames per second.",
        "analysis_duration_seconds": round(time.monotonic() - started_at, 3),
        "tracks": results,
    }
