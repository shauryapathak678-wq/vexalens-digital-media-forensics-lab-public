"""CLI compatibility wrapper around VexaLens's single local age engine."""

import argparse
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT_DIR))

try:
    import cv2
    import numpy as np

    from backend.age_gender_engine import (
        ModelInferenceError,
        ModelUnavailableError,
        estimate_apparent_ages,
    )
except ImportError as exc:
    raise SystemExit(
        f"Missing local backend dependency: {exc}\n"
        "Install the shared backend requirements with: "
        "python -m pip install -r backend\\requirements.txt"
    ) from exc


IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tif", ".tiff")


def read_image(path: Path):
    try:
        encoded = np.fromfile(path, dtype=np.uint8)
    except OSError as exc:
        raise ValueError(f"Could not read {path}: {exc}") from exc
    image = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError(f"Could not decode image: {path}")
    return image


def draw_results(frame, result):
    for face in result["faces"]:
        x, y, width, height = face["bbox"]
        cv2.rectangle(frame, (x, y), (x + width, y + height), (0, 220, 255), 2)
        age_group = face["age_range"] or "Unable to estimate"
        label = f"Face {face['face_number']}: {age_group} ({face['quality']['state']})"
        cv2.putText(
            frame,
            label,
            (x, max(y - 10, 20)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.55,
            (0, 220, 255),
            2,
        )
    return frame


def save_annotated_image(path: Path, image) -> Path:
    output_path = path.with_name(f"{path.stem}_result.jpg")
    success, encoded = cv2.imencode(".jpg", image)
    if not success:
        raise OSError("OpenCV could not encode the annotated image.")
    encoded.tofile(output_path)
    return output_path


def analyze_file(path: Path) -> bool:
    if not path.is_file():
        print(f"[!] File not found: {path}")
        return False

    try:
        image = read_image(path)
        result = estimate_apparent_ages(image)
    except (ValueError, ModelInferenceError, ModelUnavailableError) as exc:
        print(f"[!] Local analysis failed for {path.name}: {exc}")
        return False

    print(f"{path.name} | model: {result['model_name']} | version: {result['model_version']}")
    if not result["faces"]:
        print("    No face was detected above the configured detector threshold.")
    for face in result["faces"]:
        estimate = face["age_range"] or "Unable to estimate"
        print(
            f"    Face {face['face_number']}: apparent-age group = {estimate}; "
            f"quality = {face['quality']['state']}; "
            f"detector score = {face['detection_confidence']:.3f}"
        )

    try:
        output_path = save_annotated_image(path, draw_results(image.copy(), result))
    except OSError as exc:
        print(f"[!] Could not save annotated image: {exc}")
        return False
    print(f"    Annotated image saved to: {output_path}")
    return True


def analyze_folder(folder: Path) -> None:
    if not folder.is_dir():
        print(f"[!] Folder not found: {folder}")
        return
    files = sorted(
        path for path in folder.iterdir()
        if path.is_file()
        and path.suffix.lower() in IMAGE_EXTS
        and not path.stem.lower().endswith("_result")
    )
    if not files:
        print(f"[!] No supported images found in folder: {folder}")
        return
    processed = sum(analyze_file(path) for path in files)
    print(f"Folder complete: {processed}/{len(files)} image(s) processed.")


def analyze_webcam() -> None:
    camera = cv2.VideoCapture(0)
    if not camera.isOpened():
        print("[!] Could not open the webcam. Check Windows camera privacy permissions.")
        return

    print("Webcam running - press 'q' to quit.")
    frame_count = 0
    result = {"faces": []}
    try:
        while True:
            opened, frame = camera.read()
            if not opened:
                print("[!] The webcam stopped returning frames.")
                break
            frame_count += 1
            if frame_count % 10 == 0:
                try:
                    result = estimate_apparent_ages(frame)
                except (ModelInferenceError, ModelUnavailableError) as exc:
                    print(f"[!] Local analysis failed: {exc}")
                    break
            cv2.imshow("VexaLens Apparent-Age Groups (q to quit)", draw_results(frame, result))
            if cv2.waitKey(1) & 0xFF == ord("q"):
                break
    finally:
        camera.release()
        cv2.destroyAllWindows()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Local apparent-age group assessment using the VexaLens backend models."
    )
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--image", type=Path, help="Path to one image")
    mode.add_argument("--folder", type=Path, help="Path to a folder of images")
    mode.add_argument("--webcam", action="store_true", help="Analyze webcam frames")
    args = parser.parse_args()

    if args.image:
        analyze_file(args.image)
    elif args.folder:
        analyze_folder(args.folder)
    else:
        analyze_webcam()


if __name__ == "__main__":
    main()
