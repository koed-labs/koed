FROM ghcr.io/ggml-org/llama.cpp:server@sha256:c01037625b2dbac36439a76f2b6fa6e99c911b25e702414307520f37bed0c58d AS llama-server

FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    MODEL_KEY=qwen3-0.6b \
    EMBEDDING_BATCH_LIMIT=16 \
    EMBEDDING_MAX_TOKENS=4096 \
    LLAMA_N_CTX=32768 \
    LLAMA_SERVER_BINARY=/opt/llama.cpp/llama-server \
    LD_LIBRARY_PATH=/opt/llama.cpp

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    libgomp1 \
    libopenblas-dev \
  && rm -rf /var/lib/apt/lists/*

COPY --from=llama-server /app /opt/llama.cpp
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
COPY app.py /app/app.py
COPY auth.py /app/auth.py
COPY env_config.py /app/env_config.py
COPY logging_config.py /app/logging_config.py
COPY priority_scheduler.py /app/priority_scheduler.py
COPY runtime.py /app/runtime.py
COPY schemas.py /app/schemas.py
COPY settings.py /app/settings.py
COPY vectors.py /app/vectors.py

EXPOSE 8000

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
