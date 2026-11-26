# GenConViT local video screening

VexaLens uses the official GenConViT architecture at repository revision
`2c1d0bd7eecea94926595781a744e3f4b8b55290` and the model weights at Hugging
Face revision `32d6e9e3c931a37971cc756da706cf1eef643372`. The vendored source
retains its upstream MIT license. The separate pretrained weights are
CC BY-NC 4.0: use them only for noncommercial purposes and retain attribution.
Do not use the weights in a commercial service.

Administrators can install or verify the pinned checkpoint files in Admin →
Model Management. Installation downloads only from the pinned Hugging Face
revision, streams each file to a temporary path, and checks its published size
and SHA-256 before making it available. The weights are ignored by Git. Safe
PyTorch `weights_only` loading and a second checksum check are used at inference;
the model does not download additional backbone weights.

The local Python backend needs PyTorch, torchvision, timm, and dlib. Run
`npm run install:backend` to install the declared backend requirements. Inference
runs on CPU and accepts videos up to 60 seconds and 128 MB. The default rapid
mode uses the official GenConViT-ED checkpoint on one detected face frame. It
searches up to five evenly spaced frames, checking the midpoint first, so a
missing face at the exact center no longer prevents analysis. Face search stops
as soon as a usable face is found; if none is present, the service returns a
clear no-classification error. After startup preloading, a real request through
the VexaLens web proxy completed end-to-end in 46.7 seconds on the reference
CPU. The rapid model preloads in the background, and the UI waits until it is
ready before enabling this mode. In a live warmed request through the VexaLens
proxy, the bundled sample completed in 25.0 seconds. The client stops waiting
after 50 seconds. This is a low-coverage screen, not equivalent to the full
pipeline. The 15-frame ED+VAE ensemble took 274.8 seconds on the same reference
host, so it is not offered in the 50-second UI/API path. All timings vary with
hardware; a response is not guaranteed within 50 seconds on slower machines.

GenConViT provides a general video-level REAL/FAKE screening prediction based
on its evaluated datasets. Its sigmoid scores are uncalibrated and are not
probabilities of deception. The model does not classify whether mouth motion
is natural, AI-generated, dubbed, or animated, and it cannot guarantee an
accurate result for an individual video.
