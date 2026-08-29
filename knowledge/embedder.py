from embedding import HttpEmbedder, LocalEmbedder
from settings import Settings


class Embedder:
    def __init__(self, settings: Settings) -> None:
        runtime = settings.embedding_runtime()
        self._backend = runtime.backend
        self._reason = runtime.reason
        self._http = HttpEmbedder(settings) if runtime.ready and runtime.backend == "http" else None
        self._local = LocalEmbedder(settings) if runtime.ready and runtime.backend == "local" else None

    def embed_query(self, text: str) -> list[float]:
        return self._delegate().embed_query(text)

    def embed_text(self, text: str) -> list[float]:
        return self._delegate().embed_text(text)

    def embed_image(self, data: bytes, mime: str, fallback_text: str) -> list[float]:
        return self._delegate().embed_image(data, mime, fallback_text)

    def _delegate(self):
        if self._local is not None:
            return self._local
        if self._http is not None:
            return self._http
        raise RuntimeError(self._reason or "Knowledge embedding is not available")
