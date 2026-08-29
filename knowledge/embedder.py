import hashlib
import math
from typing import Any

import httpx

from settings import Settings


class Embedder:
    def __init__(self, settings: Settings) -> None:
        self._provider = (settings.embedding_provider or "hash").strip().lower()
        self._dim = max(settings.embedding_dim, 8)
        self._base_url = (settings.embedding_base_url or "").rstrip("/")
        self._api_key = settings.embedding_api_key.strip()
        self._model = settings.embedding_model.strip()

    def embed_query(self, text: str) -> list[float]:
        return self.embed_text(text)

    def embed_text(self, text: str) -> list[float]:
        if self._provider in {"", "hash"}:
            return _hash_vector(text or "", self._dim)
        return self._openai_text(text or "")

    def embed_image(self, data: bytes, mime: str, fallback_text: str) -> list[float]:
        label = (fallback_text or "").strip() or "image"
        if self._provider in {"", "hash"}:
            return self.embed_text(label)
        try:
            return self._openai_image(data, mime)
        except Exception:
            return self.embed_text(label)

    def _openai_text(self, text: str) -> list[float]:
        payload: dict[str, Any] = {"input": text}
        if self._model:
            payload["model"] = self._model
        data = self._post("/v1/embeddings", payload)
        vector = _first_embedding(data)
        return _fit_dim(vector, self._dim)

    def _openai_image(self, data: bytes, mime: str) -> list[float]:
        import base64

        encoded = base64.b64encode(data).decode("ascii")
        data_url = f"data:{mime or 'image/png'};base64,{encoded}"
        payload: dict[str, Any] = {
            "input": [{"image": data_url}],
        }
        if self._model:
            payload["model"] = self._model
        try:
            data = self._post("/v1/embeddings", payload)
            return _fit_dim(_first_embedding(data), self._dim)
        except Exception:
            payload = {"input": [{"type": "image_url", "image_url": {"url": data_url}}]}
            if self._model:
                payload["model"] = self._model
            data = self._post("/v1/embeddings", payload)
            return _fit_dim(_first_embedding(data), self._dim)

    def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        if not self._base_url:
            raise RuntimeError("KNOWLEDGE_EMBEDDING_BASE_URL is required for openai embeddings")
        headers = {"content-type": "application/json"}
        if self._api_key:
            headers["authorization"] = f"Bearer {self._api_key}"
        response = httpx.post(self._base_url + path, json=payload, headers=headers, timeout=60.0)
        response.raise_for_status()
        return response.json()


def _first_embedding(data: dict[str, Any]) -> list[float]:
    items = data.get("data") or []
    if not items:
        raise RuntimeError("embedding response did not contain vectors")
    vector = items[0].get("embedding")
    if not isinstance(vector, list) or not vector:
        raise RuntimeError("embedding response was empty")
    return [float(value) for value in vector]


def _hash_vector(value: str | bytes, dim: int) -> list[float]:
    if isinstance(value, str):
        payload = value.encode("utf-8")
    else:
        payload = value
    digest = hashlib.sha256(payload).digest()
    raw: list[float] = []
    seed = digest
    while len(raw) < dim:
        for byte in seed:
            raw.append((byte / 255.0) * 2.0 - 1.0)
            if len(raw) >= dim:
                break
        seed = hashlib.sha256(seed).digest()
    return _normalize(raw[:dim])


def _fit_dim(vector: list[float], dim: int) -> list[float]:
    if len(vector) == dim:
        return _normalize(vector)
    if len(vector) > dim:
        return _normalize(vector[:dim])
    padded = list(vector) + [0.0] * (dim - len(vector))
    return _normalize(padded)


def _normalize(vector: list[float]) -> list[float]:
    norm = math.sqrt(sum(value * value for value in vector))
    if norm == 0:
        return vector
    return [value / norm for value in vector]
