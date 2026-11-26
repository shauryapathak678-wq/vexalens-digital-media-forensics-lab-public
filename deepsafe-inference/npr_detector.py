import os
import sys

import torch
import torchvision.transforms as transforms
from deepsafe_sdk import ImageModel, PredictionResult


MODEL_REPO_SUBDIR = "npr_deepfakedetection"
MODEL_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_CODE_PATH = os.path.join(MODEL_DIR, MODEL_REPO_SUBDIR)
if MODEL_CODE_PATH not in sys.path:
    sys.path.insert(0, MODEL_CODE_PATH)

from networks.resnet import resnet50


class NPRPrediction(PredictionResult):
    raw_logit: float


class NPRDetector(ImageModel):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        use_gpu = os.environ.get("USE_GPU", "false").lower() == "true"
        self.device = torch.device(
            "cuda" if use_gpu and torch.cuda.is_available() else "cpu"
        )
        self.transform = transforms.Compose(
            [
                transforms.Resize((256, 256)),
                transforms.ToTensor(),
                transforms.Normalize(
                    mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]
                ),
            ]
        )

    def load(self):
        weights_path = self.weights_path("npr_deepfakedetection/weights/NPR.pth")
        model = resnet50(num_classes=1)
        state_dict = torch.load(
            weights_path, map_location=self.device, weights_only=False
        )
        if all(key.startswith("module.") for key in state_dict):
            state_dict = {key[len("module.") :]: value for key, value in state_dict.items()}
        model.load_state_dict(state_dict)
        model.to(self.device)
        model.eval()
        self.model = model

    def predict(self, input_data: str, threshold: float) -> NPRPrediction:
        image = self.decode_image(input_data)
        tensor = self.transform(image).unsqueeze(0).to(self.device)
        with torch.no_grad():
            logit_tensor = self.model(tensor).reshape(-1)[0]
            raw_logit = float(logit_tensor.item())
            score = float(torch.sigmoid(logit_tensor.double()).item())
        prediction = int(score >= threshold)
        return NPRPrediction(
            model=self._model_name,
            probability=score,
            prediction=prediction,
            class_name="fake" if prediction else "real",
            inference_time=0.0,
            raw_logit=raw_logit,
        )
