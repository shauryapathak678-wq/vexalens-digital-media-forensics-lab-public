import os
import sys
import re
from typing import Union, Dict, Optional
from pathlib import Path

from PIL import Image

# Global model references with lazy initialization for resilient startup
_model_path = None
_ai_detector = None
_ocr_reader = None

def get_ai_detector():
    """Lazily downloads and initializes the Smaug AI Image Detector model."""
    global _ai_detector, _model_path
    if _ai_detector is None:
        print("Loading Smaug AI Image Detector... (first time may take a minute)")
        from huggingface_hub import snapshot_download
        _model_path = snapshot_download("abacusai/Smaug-AI-Image-Detector")
        if _model_path not in sys.path:
            sys.path.insert(0, _model_path)
        from smaug_image_detect import SmaugImageDetect
        _ai_detector = SmaugImageDetect.from_pretrained(_model_path)
    return _ai_detector

def get_ocr_reader():
    """Lazily initializes the EasyOCR reader."""
    global _ocr_reader
    if _ocr_reader is None:
        import easyocr
        import torch
        use_gpu = torch.cuda.is_available()
        _ocr_reader = easyocr.Reader(['en'], gpu=use_gpu)
    return _ocr_reader

# ---------- Category Keywords ----------
CATEGORY_KEYWORDS = {
    "Payment / UPI": [
        r"\bupi\b", r"gpay", r"google pay", r"phonepe", r"paytm", r"bhim",
        r"transaction id", r"\butr\b", r"paid to", r"payment successful",
        r"sent to", r"received from", r"₹\s*\d", r"rs\.?\s*\d"
    ],
    "Bank Receipt": [
        r"account (no|number|num)", r"\bifsc\b", r"neft", r"rtgs", r"imps",
        r"available balance", r"account balance", r"bank statement",
        r"credited", r"debited", r"a/c no", r"account holder"
    ],
    "Digital Invoice": [
        r"invoice", r"tax invoice", r"gstin", r"\bgst\b", r"bill to",
        r"invoice no", r"invoice date", r"total amount", r"sub total",
        r"cgst", r"sgst", r"igst"
    ],
    "Chat Screenshot": [
        r"online", r"last seen", r"typing", r"whatsapp", r"telegram",
        r"message", r"delivered", r"read", r"yesterday", r"today"
    ],
    "Social Media": [
        r"like", r"comment", r"share", r"followers", r"following",
        r"instagram", r"twitter", r"facebook", r"reel", r"story",
        r"views", r"retweet"
    ],
    "App Interface": [
        r"settings", r"profile", r"home", r"menu", r"search",
        r"notification", r"dashboard", r"logout"
    ]
}

def _classify_category(text: str) -> tuple[str, float]:
    text = text.lower()
    scores = {}

    for category, patterns in CATEGORY_KEYWORDS.items():
        score = 0
        for pat in patterns:
            matches = re.findall(pat, text, re.IGNORECASE)
            score += len(matches)
        scores[category] = score

    if not any(scores.values()):
        return "General / Other", 0.4

    best = max(scores, key=scores.get)
    max_score = scores[best]
    confidence = min(0.95, 0.45 + (max_score * 0.12))
    return best, round(confidence, 2)


def detect(
    image: Union[str, Path, Image.Image, bytes],
    ai_threshold: float = 0.55
) -> Dict:
    """
    Main detection function.

    Returns:
    {
        "is_ai_generated": bool,
        "ai_probability": float,
        "evidence_category": str,
        "category_confidence": float,
        "extracted_text": str,
        "text_preview": str
    }
    """
    # Load image
    if isinstance(image, (str, Path)):
        img = Image.open(image).convert("RGB")
        img_path = str(image)
    elif isinstance(image, bytes):
        from io import BytesIO
        img = Image.open(BytesIO(image)).convert("RGB")
        img_path = None
    else:
        img = image.convert("RGB")
        img_path = None

    # 1. AI Detection using Smaug
    detector = get_ai_detector()
    if img_path:
        ai_prob = float(detector(img_path))
    else:
        import tempfile
        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
            img.save(tmp.name, "JPEG")
            ai_prob = float(detector(tmp.name))
            try:
                os.unlink(tmp.name)
            except OSError:
                pass

    is_ai = ai_prob >= ai_threshold

    # 2. OCR using EasyOCR
    reader = get_ocr_reader()
    import numpy as np
    ocr_result = reader.readtext(np.array(img), detail=0)
    full_text = " ".join(ocr_result)

    # 3. Category classification based on extracted text
    category, cat_conf = _classify_category(full_text)

    return {
        "is_ai_generated": is_ai,
        "ai_probability": round(ai_prob, 4),
        "evidence_category": category,
        "category_confidence": cat_conf,
        "extracted_text": full_text,
        "text_preview": full_text[:300] + ("..." if len(full_text) > 300 else "")
    }

if __name__ == "__main__":
    if len(sys.argv) > 1:
        test_file = sys.argv[1]
        print(f"Testing detection on {test_file}...")
        res = detect(test_file)
        print(res)
    else:
        print("Usage: python detector.py <image_path>")

