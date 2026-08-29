from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass

from pydantic_settings import BaseSettings, SettingsConfigDict


@dataclass(frozen=True)
class EmbeddingSpec:
    model_id: str
    dim: int


@dataclass(frozen=True)
class EmbeddingRuntime:
    ready: bool
    backend: str
    reason: str


# Default family is WeMM-Embedding. SIZE picks a variant; MODEL can replace the family entirely.
_DEFAULT_VARIANTS = {
    "2b": EmbeddingSpec("tencent/WeMM-Embedding-2B", 2048),
    "4b": EmbeddingSpec("tencent/WeMM-Embedding-4B", 2560),
    "9b": EmbeddingSpec("tencent/WeMM-Embedding-9B", 4096),
}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="KNOWLEDGE_", extra="ignore")

    internal_token: str = ""
    database_url: str = "postgresql://kross:kross@127.0.0.1:5432/kross"
    embedding_provider: str = "auto"
    embedding_base_url: str = ""
    embedding_api_key: str = ""
    embedding_size: str = "2b"
    embedding_model: str = ""
    embedding_dim: int = 0
    embedding_model_dir: str = ""
    embedding_hub: str = "huggingface"
    embedding_device: str = "auto"

    def embedding_backend(self) -> str:
        value = (self.embedding_provider or "auto").strip().lower()
        if value in {"hash"}:
            return "none"
        if value in {"api", "openai", "wemm", "tencent"}:
            return "http"
        if value in {"", "auto"}:
            if (self.embedding_base_url or "").strip():
                return "http"
            if has_accelerator():
                return "local"
            return "none"
        return value

    def embedding_spec(self) -> EmbeddingSpec:
        custom = (self.embedding_model or "").strip()
        size = (self.embedding_size or "2b").strip().lower()
        preset = _DEFAULT_VARIANTS.get(size, _DEFAULT_VARIANTS["2b"])
        if custom and not _is_default_family(custom):
            dim = self.embedding_dim if self.embedding_dim > 0 else 1024
            return EmbeddingSpec(custom, max(dim, 8))
        model_id = custom or preset.model_id
        dim = self.embedding_dim if self.embedding_dim > 0 else _dim_for(model_id, preset.dim)
        return EmbeddingSpec(model_id, max(dim, 8))

    def embedding_runtime(self) -> EmbeddingRuntime:
        backend = self.embedding_backend()
        if backend == "http":
            if (self.embedding_base_url or "").strip():
                return EmbeddingRuntime(True, "http", "")
            return EmbeddingRuntime(
                False,
                "http",
                "Remote embedding is not configured (KNOWLEDGE_EMBEDDING_BASE_URL)",
            )
        if backend == "local":
            if has_accelerator():
                return EmbeddingRuntime(True, "local", "")
            return EmbeddingRuntime(
                False,
                "local",
                "Local embedding requires a GPU",
            )
        return EmbeddingRuntime(
            False,
            backend,
            "Knowledge embedding requires a GPU or a remote embedding endpoint",
        )


def has_accelerator() -> bool:
    try:
        import torch

        if torch.cuda.is_available():
            return True
        mps = getattr(torch.backends, "mps", None)
        if mps is not None and torch.backends.mps.is_available():
            return True
    except Exception:
        pass
    nvidia = shutil.which("nvidia-smi")
    if not nvidia:
        return False
    result = subprocess.run([nvidia, "-L"], check=False, capture_output=True, text=True)
    return result.returncode == 0 and bool((result.stdout or "").strip())


def _is_default_family(model_id: str) -> bool:
    lowered = model_id.lower()
    return "wemm-embedding" in lowered or model_id.lower() in {
        spec.model_id.lower() for spec in _DEFAULT_VARIANTS.values()
    }


def _dim_for(model_id: str, fallback: int) -> int:
    lowered = model_id.lower()
    for spec in _DEFAULT_VARIANTS.values():
        if spec.model_id.lower() == lowered or spec.model_id.split("/")[-1].lower() in lowered:
            return spec.dim
    return fallback


def load_settings() -> Settings:
    return Settings()
