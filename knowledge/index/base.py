from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class ChunkRecord:
    document_id: str
    space_id: str
    title: str
    text: str
    embedding: list[float]
    published: bool = False
    modality: str = "text"
    source_key: str = ""


@dataclass(frozen=True)
class SearchHit:
    document_id: str
    title: str
    space_id: str
    excerpt: str
    score: float
    modality: str = "text"


class VectorIndex(Protocol):
    def replace_document(self, document_id: str, chunks: list[ChunkRecord]) -> None: ...

    def set_published(self, document_id: str, published: bool) -> int: ...

    def search(
        self,
        query: str,
        query_embedding: list[float],
        space_ids: list[str],
        top_k: int,
        published_only: bool,
    ) -> list[SearchHit]: ...
