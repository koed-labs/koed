FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    MODEL_KEY=qwen3-0.6b \
    EMBEDDING_BATCH_LIMIT=16 \
    EMBEDDING_MAX_TOKENS=4096 \
    LLAMA_N_CTX=32000

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
