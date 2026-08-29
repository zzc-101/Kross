FROM python:3.12-slim
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends antiword \
  && rm -rf /var/lib/apt/lists/*
COPY pyproject.toml .
COPY main.py settings.py models.py service.py embedder.py ./
COPY pipeline pipeline
COPY parsers parsers
COPY index index
RUN pip install --no-cache-dir --upgrade pip \
  && pip install --no-cache-dir .
EXPOSE 8090
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8090"]
