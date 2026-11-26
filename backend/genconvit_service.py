"""Local GenConViT video-level deepfake screening."""

from __future__ import annotations

import hashlib
import importlib.util
import math
import threading
import time
from pathlib import Path
from typing import Any

import cv2
import numpy as np


MODEL_VERSION = "32d6e9e3c931a37971cc756da706cf1eef643372"
MAX_VIDEO_DURATION_SECONDS = 60
MAX_VIDEO_BYTES = 128 * 1024 * 1024
NUM_SAMPLED_FRAMES = 15
RAPID_FACE_SEARCH_FRAMES = 5
FACE_SIZE = 224

_ROOT = Path(__file__).resolve().parent.parent
_WEIGHTS = {
    "ed": (
        _ROOT / "models" / "genconvit" / "genconvit_ed_inference.pth",
        238174949,
        "86f0c2e875016435def7d031b357bda5dc0061367290d73de121186df3f03f8c",
    ),
    "vae": (
        _ROOT / "models" / "genconvit" / "genconvit_vae_inference.pth",
        2782175601,
        "53c627c82d1439fc80e18ac462c1ed6969a3babe5376124a5c38d1c0c88c9042",
    ),
}
_LOCK = threading.Lock()
_FAST_LOCK = threading.Lock()
_MODEL: Any = None
_TORCH: Any = None
_FACE_DETECTOR: Any = None
_FAST_MODEL: Any = None
_FAST_TORCH: Any = None
_FAST_FACE_DETECTOR: Any = None
_FAST_LOADING = False
_FAST_ERROR: str | None = None


class GenConViTNotConfiguredError(RuntimeError):
    pass


class GenConViTInputError(ValueError):
    pass


class GenConViTInferenceError(RuntimeError):
    pass


def get_genconvit_status() -> dict[str, Any]:
    dependencies = {
        "PyTorch": "torch",
        "torchvision": "torchvision",
        "timm": "timm",
        "dlib": "dlib",
        "PyYAML": "yaml",
    }
    missing_dependencies = [
        label for label, module in dependencies.items()
        if importlib.util.find_spec(module) is None
    ]
    missing_files = [
        str(path.relative_to(_ROOT))
        for path, expected_size, _ in _WEIGHTS.values()
        if not path.is_file() or path.stat().st_size != expected_size
    ]
    return {
        "configured": not missing_dependencies and not missing_files,
        "model": "GenConViT",
        "model_version": MODEL_VERSION,
        "device": "CPU",
        "num_sampled_frames": NUM_SAMPLED_FRAMES,
        "rapid_face_search_frames": RAPID_FACE_SEARCH_FRAMES,
        "max_video_duration_seconds": MAX_VIDEO_DURATION_SECONDS,
        "max_video_bytes": MAX_VIDEO_BYTES,
        "missing_dependencies": missing_dependencies,
        "missing_files": missing_files,
        "category": "video-level deepfake screening; not a mouth-motion-origin classifier",
        "fast_model_ready": _FAST_MODEL is not None,
        "fast_model_loading": _FAST_LOADING,
        "fast_model_error": _FAST_ERROR,
    }


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as model_file:
        for chunk in iter(lambda: model_file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _safe_state_dict(torch: Any, path: Path, expected_size: int, expected_sha256: str) -> dict[str, Any]:
    if not path.is_file() or path.stat().st_size != expected_size:
        raise GenConViTNotConfiguredError(f"Missing or incorrectly sized GenConViT checkpoint: {path.name}.")
    if _sha256_file(path) != expected_sha256:
        raise GenConViTInferenceError(f"SHA-256 verification failed for GenConViT checkpoint: {path.name}.")
    try:
        state = torch.load(path, map_location="cpu", weights_only=True, mmap=True)
    except Exception as exc:
        raise GenConViTInferenceError(f"Safe checkpoint loading failed for {path.name}: {exc}") from exc
    if isinstance(state, dict) and "state_dict" in state and isinstance(state["state_dict"], dict):
        state = state["state_dict"]
    if not isinstance(state, dict) or not state:
        raise GenConViTInferenceError(f"GenConViT checkpoint {path.name} did not contain a state dictionary.")
    return state


def _predicted_class(fake_score: float, real_score: float) -> str:
    if not math.isfinite(fake_score) or not math.isfinite(real_score):
        raise GenConViTInferenceError("GenConViT returned a non-finite class score.")
    if not 0 <= fake_score <= 1 or not 0 <= real_score <= 1:
        raise GenConViTInferenceError("GenConViT scores are outside the expected range.")
    return "FAKE" if fake_score >= real_score else "REAL"


def _load_model() -> tuple[Any, Any, Any]:
    global _MODEL, _TORCH, _FACE_DETECTOR
    with _LOCK:
        if _MODEL is not None:
            return _MODEL, _TORCH, _FACE_DETECTOR

        status = get_genconvit_status()
        if not status["configured"]:
            missing = status["missing_files"] + status["missing_dependencies"]
            raise GenConViTNotConfiguredError("GenConViT is not ready. Missing: " + ", ".join(missing))

        try:
            import dlib
            import torch
            import yaml
            from backend.vendor.genconvit.model.genconvit_ed import GenConViTED
            from backend.vendor.genconvit.model.genconvit_vae import GenConViTVAE

            with (_ROOT / "backend" / "vendor" / "genconvit" / "model" / "config.yaml").open(
                "r", encoding="utf-8"
            ) as config_file:
                config = yaml.safe_load(config_file)
            if not isinstance(config, dict):
                raise GenConViTInferenceError("The pinned GenConViT model configuration is invalid.")

            torch.set_num_threads(max(1, min(4, torch.get_num_threads())))
            model_ed = GenConViTED(config, pretrained=False)
            model_vae = GenConViTVAE(config, pretrained=False)
            ed_path, ed_size, ed_hash = _WEIGHTS["ed"]
            vae_path, vae_size, vae_hash = _WEIGHTS["vae"]
            model_ed.load_state_dict(
                _safe_state_dict(torch, ed_path, ed_size, ed_hash),
                strict=True,
                assign=True,
            )
            model_vae.load_state_dict(
                _safe_state_dict(torch, vae_path, vae_size, vae_hash),
                strict=True,
                assign=True,
            )
            model_ed.eval()
            model_vae.eval()

            class Ensemble(torch.nn.Module):
                def __init__(self) -> None:
                    super().__init__()
                    self.model_ed = model_ed
                    self.model_vae = model_vae

                def forward(self, frames: Any) -> Any:
                    ed_logits = self.model_ed(frames)
                    vae_logits, _ = self.model_vae(frames)
                    return torch.cat((ed_logits, vae_logits), dim=0)

            _MODEL = Ensemble().eval()
            _TORCH = torch
            _FACE_DETECTOR = dlib.get_frontal_face_detector()
            return _MODEL, _TORCH, _FACE_DETECTOR
        except (GenConViTNotConfiguredError, GenConViTInferenceError):
            raise
        except Exception as exc:
            raise GenConViTInferenceError(f"GenConViT initialization failed: {exc}") from exc


def _load_fast_model() -> tuple[Any, Any, Any]:
    global _FAST_MODEL, _FAST_TORCH, _FAST_FACE_DETECTOR, _FAST_LOADING, _FAST_ERROR
    with _FAST_LOCK:
        if _FAST_MODEL is not None:
            return _FAST_MODEL, _FAST_TORCH, _FAST_FACE_DETECTOR

        _FAST_LOADING = True
        _FAST_ERROR = None
        status = get_genconvit_status()
        if not status["configured"]:
            missing = status["missing_files"] + status["missing_dependencies"]
            _FAST_ERROR = "GenConViT is not ready. Missing: " + ", ".join(missing)
            _FAST_LOADING = False
            raise GenConViTNotConfiguredError("GenConViT is not ready. Missing: " + ", ".join(missing))

        try:
            import dlib
            import torch
            import yaml
            from backend.vendor.genconvit.model.genconvit_ed import GenConViTED

            with (_ROOT / "backend" / "vendor" / "genconvit" / "model" / "config.yaml").open(
                "r", encoding="utf-8"
            ) as config_file:
                config = yaml.safe_load(config_file)
            if not isinstance(config, dict):
                raise GenConViTInferenceError("The pinned GenConViT model configuration is invalid.")

            torch.set_num_threads(max(1, min(10, torch.get_num_threads())))
            model = GenConViTED(config, pretrained=False)
            ed_path, ed_size, ed_hash = _WEIGHTS["ed"]
            model.load_state_dict(
                _safe_state_dict(torch, ed_path, ed_size, ed_hash),
                strict=True,
                assign=True,
            )
            model.eval()
            _FAST_MODEL = model
            _FAST_TORCH = torch
            _FAST_FACE_DETECTOR = dlib.get_frontal_face_detector()
            return _FAST_MODEL, _FAST_TORCH, _FAST_FACE_DETECTOR
        except (GenConViTNotConfiguredError, GenConViTInferenceError):
            _FAST_ERROR = "Rapid model initialization failed."
            raise
        except Exception as exc:
            _FAST_ERROR = f"GenConViT rapid-screen initialization failed: {exc}"
            raise GenConViTInferenceError(f"GenConViT rapid-screen initialization failed: {exc}") from exc
        finally:
            _FAST_LOADING = False


def warm_genconvit_fast_model() -> None:
    _load_fast_model()


def _rapid_face_search_indices(frame_count: int, search_frame_count: int) -> list[int]:
    indices = np.linspace(
        0,
        frame_count - 1,
        min(search_frame_count, frame_count),
        dtype=int,
    )
    midpoint = (frame_count - 1) / 2
    return sorted(
        {int(index) for index in indices},
        key=lambda index: (abs(index - midpoint), index),
    )


def _extract_sampled_faces(
    video_path: Path,
    detector: Any,
    sample_count: int = NUM_SAMPLED_FRAMES,
    face_search_count: int = 1,
) -> tuple[list[np.ndarray], float, float, int, int]:
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise GenConViTInputError("The uploaded file could not be opened as a supported video.")
    try:
        frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
        fps = float(capture.get(cv2.CAP_PROP_FPS))
        if frame_count < 1 or not math.isfinite(fps) or fps <= 0:
            raise GenConViTInputError("The video has no valid frame count or frame rate.")
        duration = frame_count / fps
        if duration > MAX_VIDEO_DURATION_SECONDS:
            raise GenConViTInputError(
                f"Video duration must not exceed {MAX_VIDEO_DURATION_SECONDS} seconds."
            )

        indices = (
            _rapid_face_search_indices(frame_count, face_search_count)
            if sample_count == 1
            else np.linspace(0, frame_count - 1, sample_count, dtype=int)
        )
        faces: list[np.ndarray] = []
        frames_with_faces = 0
        frames_scanned = 0
        for frame_index in indices:
            capture.set(cv2.CAP_PROP_POS_FRAMES, int(frame_index))
            read_ok, bgr_frame = capture.read()
            if not read_ok or bgr_frame is None:
                continue
            frames_scanned += 1
            rgb_frame = cv2.cvtColor(bgr_frame, cv2.COLOR_BGR2RGB)
            detector_frame = cv2.cvtColor(rgb_frame, cv2.COLOR_RGB2BGR)
            rectangles, _, _ = detector.run(detector_frame, 0, 0.0)
            if rectangles:
                frames_with_faces += 1
            for rectangle in rectangles:
                left = max(0, rectangle.left())
                top = max(0, rectangle.top())
                right = min(rgb_frame.shape[1], rectangle.right())
                bottom = min(rgb_frame.shape[0], rectangle.bottom())
                if right <= left or bottom <= top:
                    continue
                face = rgb_frame[top:bottom, left:right]
                resized = cv2.resize(face, (FACE_SIZE, FACE_SIZE), interpolation=cv2.INTER_AREA)
                faces.append(resized)
                if len(faces) >= sample_count:
                    break
            if len(faces) >= sample_count:
                break

        return faces, fps, duration, frames_with_faces, frames_scanned
    finally:
        capture.release()


def _prepare_model_frames(faces: list[np.ndarray], torch: Any) -> Any:
    frames = torch.from_numpy(np.asarray(faces)).float().permute(0, 3, 1, 2).contiguous()
    frames.div_(255.0)
    mean = torch.tensor([0.485, 0.456, 0.406]).view(1, 3, 1, 1)
    std = torch.tensor([0.229, 0.224, 0.225]).view(1, 3, 1, 1)
    return frames.sub_(mean).div_(std)


def analyze_genconvit_fast_video(video_path: Path) -> dict[str, Any]:
    start_time = time.perf_counter()
    model, torch, detector = _load_fast_model()
    faces, fps, duration, frames_with_faces, face_search_frames = _extract_sampled_faces(
        video_path,
        detector,
        sample_count=1,
        face_search_count=RAPID_FACE_SEARCH_FRAMES,
    )
    if not faces:
        raise GenConViTInputError(
            f"No face was detected in any of the {face_search_frames} sampled frames across the clip; "
            "no classification was produced. Use a video with a clearly visible face."
        )

    frames = _prepare_model_frames(faces, torch)
    try:
        with torch.inference_mode():
            logits = model(frames)
            scores = torch.sigmoid(logits).mean(dim=0)
        if scores.numel() != 2 or not torch.isfinite(scores).all():
            raise GenConViTInferenceError("GenConViT returned invalid class scores.")
        fake_score = float(scores[0].item())
        real_score = float(scores[1].item())
        predicted_class = _predicted_class(fake_score, real_score)
    except GenConViTInferenceError:
        raise
    except Exception as exc:
        raise GenConViTInferenceError(f"GenConViT rapid-screen inference failed: {exc}") from exc

    return {
        "status": "completed",
        "analysis_mode": "rapid",
        "model": "GenConViT",
        "model_version": MODEL_VERSION,
        "predicted_class": predicted_class,
        "fake_score": fake_score,
        "real_score": real_score,
        "score_semantics": "Uncalibrated GenConViT-ED score from one detected face frame; reduced frame coverage, not a probability of deception.",
        "sampled_frames": 1,
        "faces_detected": len(faces),
        "frames_with_faces": frames_with_faces,
        "face_search_frames": face_search_frames,
        "video_fps": fps,
        "video_duration_seconds": duration,
        "inference_seconds": time.perf_counter() - start_time,
        "analysis_timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "device": "CPU",
        "classification_scope": "Rapid single-face-frame GenConViT-ED screen selected from up to five evenly spaced frames; not the full 15-frame ensemble and not a mouth-motion-origin verdict.",
    }


def analyze_genconvit_video(video_path: Path) -> dict[str, Any]:
    start_time = time.perf_counter()
    model, torch, detector = _load_model()
    faces, fps, duration, frames_with_faces, face_search_frames = _extract_sampled_faces(video_path, detector)
    if not faces:
        raise GenConViTInputError("No face was detected in the 15 sampled frames; no video classification was produced.")

    frames = _prepare_model_frames(faces, torch)

    try:
        with torch.inference_mode():
            logits = model(frames)
            scores = torch.sigmoid(logits).mean(dim=0)
        if scores.numel() != 2 or not torch.isfinite(scores).all():
            raise GenConViTInferenceError("GenConViT returned invalid class scores.")
        fake_score = float(scores[0].item())
        real_score = float(scores[1].item())
        predicted_class = _predicted_class(fake_score, real_score)
    except GenConViTInferenceError:
        raise
    except Exception as exc:
        raise GenConViTInferenceError(f"GenConViT inference failed: {exc}") from exc

    return {
        "status": "completed",
        "analysis_mode": "full",
        "model": "GenConViT",
        "model_version": MODEL_VERSION,
        "predicted_class": predicted_class,
        "fake_score": fake_score,
        "real_score": real_score,
        "score_semantics": "Uncalibrated sigmoid model score; not a probability of deception.",
        "sampled_frames": NUM_SAMPLED_FRAMES,
        "faces_detected": len(faces),
        "frames_with_faces": frames_with_faces,
        "face_search_frames": face_search_frames,
        "video_fps": fps,
        "video_duration_seconds": duration,
        "inference_seconds": time.perf_counter() - start_time,
        "analysis_timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "device": "CPU",
        "classification_scope": "General video-level deepfake screening; not a mouth-motion-origin verdict.",
    }
