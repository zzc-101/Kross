from __future__ import annotations

import base64
import logging
from pathlib import Path
from typing import Any

import httpx

from settings import Settings

log = logging.getLogger("kross.knowledge.embedding")

DOCUMENT_INSTRUCTION = "Represent this document for retrieval"


class HttpEmbedder:
    def __init__(self, settings: Settings) -> None:
        spec = settings.embedding_spec()
        self._base_url = (settings.embedding_base_url or "").rstrip("/")
        self._api_key = settings.embedding_api_key.strip()
        self._model = spec.model_id
        self._dim = spec.dim

    def embed_query(self, text: str) -> list[float]:
        return self.embed_text(text)

    def embed_text(self, text: str) -> list[float]:
        self._require_url()
        payload: dict[str, Any] = {"input": text or ""}
        if self._model:
            payload["model"] = self._model
        data = self._post("/v1/embeddings", payload)
        return fit_dim(_first_embedding(data), self._dim)

    def embed_image(self, data: bytes, mime: str, fallback_text: str) -> list[float]:
        self._require_url()
        data_url = _data_url(data, mime)
        if _looks_like_multimodal_host(self._base_url):
            items: list[dict[str, Any]] = [
                {"type": "image_url", "image_url": {"url": data_url}},
            ]
            if fallback_text:
                items.append({"type": "text", "text": fallback_text})
            payload: dict[str, Any] = {
                "model": self._model,
                "input": items,
                "instructions": DOCUMENT_INSTRUCTION,
            }
            result = self._post("/v1/embeddings/multimodal", payload)
            return fit_dim(_first_embedding(result), self._dim)
        payload = {
            "messages": [
                {
                    "role": "user",
                    "content": _image_content(data_url, fallback_text),
                }
            ]
        }
        if self._model:
            payload["model"] = self._model
        try:
            result = self._post("/v1/embeddings", payload)
            return fit_dim(_first_embedding(result), self._dim)
        except Exception:
            payload = {"input": [{"type": "image_url", "image_url": {"url": data_url}}]}
            if self._model:
                payload["model"] = self._model
            result = self._post("/v1/embeddings", payload)
            return fit_dim(_first_embedding(result), self._dim)

    def _require_url(self) -> None:
        if not self._base_url:
            raise RuntimeError("KNOWLEDGE_EMBEDDING_BASE_URL is required when provider=http")

    def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        headers = {"content-type": "application/json"}
        if self._api_key:
            headers["authorization"] = f"Bearer {self._api_key}"
        response = httpx.post(self._base_url + path, json=payload, headers=headers, timeout=120.0)
        response.raise_for_status()
        return response.json()


class LocalEmbedder:
    def __init__(self, settings: Settings) -> None:
        spec = settings.embedding_spec()
        self._model_id = spec.model_id
        self._dim = spec.dim
        self._model_dir = (settings.embedding_model_dir or "").strip()
        self._hub = (settings.embedding_hub or "huggingface").strip().lower()
        self._device = (settings.embedding_device or "auto").strip().lower()
        self._model = None

    def embed_query(self, text: str) -> list[float]:
        return self._encode(text=text or "", image=None, is_query=True)

    def embed_text(self, text: str) -> list[float]:
        return self._encode(text=text or "", image=None, is_query=False)

    def embed_image(self, data: bytes, mime: str, fallback_text: str) -> list[float]:
        return self._encode(text=(fallback_text or "").strip(), image=data, is_query=False)

    def _encode(self, *, text: str, image: bytes | None, is_query: bool) -> list[float]:
        model = self._load()
        item: Any
        if image is None:
            item = text
        else:
            pil = _pil_image(image)
            item = {"image": pil, "text": text} if text else {"image": pil}
        if is_query and hasattr(model, "encode_query"):
            vector = model.encode_query([item], normalize_embeddings=True)
        elif hasattr(model, "encode_document"):
            vector = model.encode_document([item], normalize_embeddings=True)
        else:
            vector = model.encode([item], normalize_embeddings=True)
        row = vector[0]
        return fit_dim([float(value) for value in row], self._dim)

    def _load(self):
        if self._model is not None:
            return self._model
        try:
            from sentence_transformers import SentenceTransformer
        except ImportError as error:
            raise RuntimeError(
                "Local embedding requires extras: pip install 'kross-knowledge[local]'"
            ) from error
        path = ensure_local_model(
            model_id=self._model_id,
            model_dir=self._model_dir,
            hub=self._hub,
        )
        device = None if self._device in {"", "auto"} else self._device
        log.info("loading embedding model %s from %s", self._model_id, path)
        self._model = SentenceTransformer(path, trust_remote_code=True, device=device)
        return self._model


def ensure_local_model(*, model_id: str, model_dir: str, hub: str) -> str:
    target = (
        Path(model_dir)
        if model_dir
        else Path.home() / ".cache" / "kross-knowledge" / "models" / _safe_name(model_id)
    )
    if _looks_like_model(target):
        return str(target)
    target.mkdir(parents=True, exist_ok=True)
    log.info("downloading %s via %s into %s", model_id, hub, target)
    if hub in {"modelscope", "modelspace"}:
        _download_modelscope(model_id, target)
    else:
        _download_huggingface(model_id, target)
    if not _looks_like_model(target):
        raise RuntimeError(f"downloaded model is incomplete: {target}")
    return str(target)


def fit_dim(vector: list[float], dim: int) -> list[float]:
    import math

    if len(vector) > dim:
        vector = vector[:dim]
    elif len(vector) < dim:
        vector = list(vector) + [0.0] * (dim - len(vector))
    norm = math.sqrt(sum(value * value for value in vector))
    if norm == 0:
        return vector
    return [value / norm for value in vector]


def _download_huggingface(model_id: str, target: Path) -> None:
    try:
        from huggingface_hub import snapshot_download
    except ImportError as error:
        raise RuntimeError("huggingface-hub is required to download embedding weights") from error
    snapshot_download(repo_id=model_id, local_dir=str(target))


def _download_modelscope(model_id: str, target: Path) -> None:
    try:
        from modelscope.hub.snapshot_download import snapshot_download
    except ImportError as error:
        raise RuntimeError("modelscope is required when KNOWLEDGE_EMBEDDING_HUB=modelscope") from error
    snapshot_download(model_id=model_id, local_dir=str(target))


def _looks_like_model(path: Path) -> bool:
    return path.is_dir() and (path / "config.json").is_file()


def _safe_name(model_id: str) -> str:
    return model_id.replace("/", "--")


def _data_url(data: bytes, mime: str) -> str:
    encoded = base64.b64encode(data or b"").decode("ascii")
    return f"data:{mime or 'image/png'};base64,{encoded}"


def _image_content(data_url: str, fallback_text: str) -> list[dict[str, Any]]:
    content: list[dict[str, Any]] = [
        {"type": "image_url", "image_url": {"url": data_url}},
    ]
    if fallback_text:
        content.append({"type": "text", "text": fallback_text})
    return content


def _pil_image(data: bytes):
    from io import BytesIO

    from PIL import Image

    return Image.open(BytesIO(data)).convert("RGB")


def _first_embedding(data: dict[str, Any]) -> list[float]:
    items = data.get("data") or []
    if not items:
        raise RuntimeError("embedding response did not contain vectors")
    vector = items[0].get("embedding")
    if not isinstance(vector, list) or not vector:
        raise RuntimeError("embedding response was empty")
    return [float(value) for value in vector]


def _looks_like_multimodal_host(base_url: str) -> bool:
    host = (base_url or "").lower()
    return "tokenhub" in host or "tencentmaas" in host or host.rstrip("/").endswith("/multimodal")
