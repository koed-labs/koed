FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    MODEL_REPO=Qwen/Qwen3-Embedding-0.6B-GGUF \
    MODEL_FILE=Qwen3-Embedding-0.6B-Q8_0.gguf \
    MODEL_NAME=Qwen/Qwen3-Embedding-0.6B-GGUF \
    EMBEDDING_DIMENSIONS=1024 \
    EMBEDDING_BATCH_LIMIT=16 \
    EMBEDDING_MAX_TOKENS=32768 \
    LLAMA_N_CTX=32768

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    libopenblas-dev \
  && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
COPY app.py /app/app.py

EXPOSE 8000

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
