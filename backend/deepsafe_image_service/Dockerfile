FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

ENV DEEPSAFE_MAX_IMAGE_BYTES=26214400 \
    DEEPSAFE_MAX_IMAGE_PIXELS=30000000 \
    DEEPSAFE_MODEL_TIMEOUT_SECONDS=90

EXPOSE 8010

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8010", "--workers", "1"]
