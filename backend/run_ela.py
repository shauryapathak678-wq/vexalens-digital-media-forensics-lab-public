"""
CLI helper to run ELA analysis from Node / Express child_process when FastAPI is not running as a separate service.
"""
import sys
import json
import base64
from backend.ela_engine import perform_ela

def main():
    try:
        input_data = sys.stdin.read()
        if not input_data:
            print(json.dumps({"error": "No input received"}))
            sys.exit(1)

        payload = json.loads(input_data)
        b64_str = payload.get("image_base64", "")
        if "," in b64_str:
            b64_str = b64_str.split(",", 1)[1]

        image_bytes = base64.b64decode(b64_str)
        quality = int(payload.get("quality", 95))
        multiplier = float(payload.get("multiplier", 1.0))
        channel = payload.get("channel", "rgb")
        invert = bool(payload.get("invert", False))
        luminance_only = bool(payload.get("luminance_only", False))
        file_name = payload.get("file_name", "image.jpg")
        z_threshold = float(payload.get("z_threshold", 6.0))

        res = perform_ela(
            image_bytes=image_bytes,
            quality=quality,
            multiplier=multiplier,
            channel=channel,
            invert=invert,
            luminance_only=luminance_only,
            file_name=file_name,
            z_threshold=z_threshold,
        )
        print(json.dumps(res))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()
