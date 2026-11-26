import os
import sys

import torch
from torchvision import transforms
from deepsafe_sdk import ImageModel, PredictionResult


MODEL_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_CODE_PATH = os.path.join(MODEL_DIR, "universalfakedetect")
if MODEL_CODE_PATH not in sys.path:
    sys.path.append(MODEL_CODE_PATH)

from models import get_model


class UniversalFakePrediction(PredictionResult):
    raw_logit: float


class UniversalFakeDetector(ImageModel):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        use_gpu = os.environ.get("USE_GPU", "false").lower() == "true"
        self.device = torch.device(
            "cuda" if use_gpu and torch.cuda.is_available() else "cpu"
        )
        self.transform = transforms.Compose(
            [
                transforms.CenterCrop(224),
                transforms.ToTensor(),
                transforms.Normalize(
                    mean=[0.48145466, 0.4578275, 0.40821073],
                    std=[0.26862954, 0.26130258, 0.27577711],
                ),
            ]
        )

    def load(self):
        weights_path = self.weights_path(
            "universalfakedetect/pretrained_weights/fc_weights.pth"
        )
        model = get_model("CLIP:ViT-L/14")
        state_dict = torch.load(weights_path, map_location="cpu", weights_only=False)
        model.fc.load_state_dict(state_dict)
        model.to(self.device)
        model.eval()
        self.model = model

    def predict(self, input_data: str, threshold: float) -> UniversalFakePrediction:
        image = self.decode_image(input_data)
        tensor = self.transform(image).unsqueeze(0).to(self.device)
        with torch.no_grad():
            logit_tensor = self.model(tensor).reshape(-1)[0]
            raw_logit = float(logit_tensor.item())
            score = float(torch.sigmoid(logit_tensor.double()).item())
        prediction = int(score >= threshold)
        return UniversalFakePrediction(
            model=self._model_name,
            probability=score,
            prediction=prediction,
            class_name="fake" if prediction else "real",
            inference_time=0.0,
            raw_logit=raw_logit,
        )
