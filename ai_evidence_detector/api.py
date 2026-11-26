import os
import sys
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import uvicorn

from detector import detect

app = FastAPI(
    title="AI Evidence Detector",
    description="VexaLens Deepfake & AI Screenshot Evidence Detection API powered by Abacus AI Smaug & EasyOCR",
    version="1.0"
)

# Enable CORS for local Vite dev server and VexaLens backend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.post("/detect")
async def detect_endpoint(file: UploadFile = File(...)):
    if file.content_type and not file.content_type.startswith("image/"):
        raise HTTPException(400, "File must be an image (PNG, JPEG, WEBP)")

    contents = await file.read()
    if len(contents) == 0:
        raise HTTPException(400, "Uploaded image file is empty")

    try:
        result = detect(contents)
        return JSONResponse(content=result)
    except Exception as e:
        raise HTTPException(500, f"Detection failed: {str(e)}")

@app.get("/health")
def health():
    return {
        "status": "operational",
        "service": "AI Evidence Detector",
        "models": {
            "ai_detector": "abacusai/Smaug-AI-Image-Detector",
            "ocr": "EasyOCR (English)"
        }
    }

@app.get("/")
def root():
    return {
        "message": "AI Evidence Detector is running. POST image to /detect",
        "health": "/health",
        "docs": "/docs"
    }

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("api:app", host="0.0.0.0", port=port, reload=True)

