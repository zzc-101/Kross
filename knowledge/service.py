import base64
from uuid import uuid4

from embedder import Embedder
from index.base import ChunkRecord
from index.postgres import PostgresIndex
from models import (
    IngestRequest,
    IngestResponse,
    JobResponse,
    PublishRequest,
    PublishResponse,
    SearchHit as ApiSearchHit,
    SearchRequest,
    SearchResponse,
)
from parsers.image import is_image
from pipeline.parse import chunk_document
from settings import Settings


class KnowledgeService:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._embedder = Embedder(settings)
        self._index = PostgresIndex(settings.database_url)
        self._jobs: dict[str, JobResponse] = {}

    def ingest(self, request: IngestRequest) -> IngestResponse:
        job_id = str(uuid4())
        try:
            chunks = self._build_chunks(request)
            self._index.replace_document(request.document_id, chunks)
            status = "succeeded"
            error = None
        except Exception as exc:
            chunks = []
            status = "failed"
            error = str(exc)
        self._jobs[job_id] = JobResponse(
            id=job_id,
            document_id=request.document_id,
            kind="ingest",
            status=status,
            error_message=error,
        )
        return IngestResponse(
            document_id=request.document_id,
            job_id=job_id,
            status=status,
            chunk_count=len(chunks),
            error_message=error,
        )

    def publish(self, document_id: str, request: PublishRequest) -> PublishResponse:
        count = self._index.set_published(document_id, request.published)
        return PublishResponse(
            document_id=document_id,
            published=request.published,
            chunk_count=count,
        )

    def search(self, request: SearchRequest) -> SearchResponse:
        query = (request.query or "").strip()
        if not query:
            return SearchResponse(hits=[])
        embedding = self._embedder.embed_query(query)
        hits = self._index.search(
            query=query,
            query_embedding=embedding,
            space_ids=request.space_ids,
            top_k=request.top_k,
            published_only=request.published_only,
        )
        return SearchResponse(
            hits=[
                ApiSearchHit(
                    document_id=hit.document_id,
                    title=hit.title,
                    space_id=hit.space_id,
                    excerpt=hit.excerpt,
                    score=hit.score,
                    modality=hit.modality,
                )
                for hit in hits
            ]
        )

    def job(self, job_id: str) -> JobResponse | None:
        return self._jobs.get(job_id)

    def _build_chunks(self, request: IngestRequest) -> list[ChunkRecord]:
        payload = _decode_bytes(request.file_base64) or _decode_bytes(request.image_base64)
        if is_image(filename=request.filename, mime=request.mime):
            fallback = " ".join(
                part for part in [request.title, request.filename] if part
            ).strip()
            embedding = self._embedder.embed_image(payload, request.mime, fallback)
            body = fallback or request.filename or request.title
            return [
                ChunkRecord(
                    document_id=request.document_id,
                    space_id=request.space_id,
                    title=request.title,
                    text=body,
                    embedding=embedding,
                    published=False,
                    modality="image",
                    source_key=request.source_key,
                )
            ]
        texts = chunk_document(
            filename=request.filename,
            mime=request.mime,
            text=request.text,
            data=payload,
        )
        if not texts:
            texts = [request.title or request.filename]
        return [
            ChunkRecord(
                document_id=request.document_id,
                space_id=request.space_id,
                title=request.title,
                text=chunk,
                embedding=self._embedder.embed_text(chunk),
                published=False,
                modality="text",
                source_key=request.source_key,
            )
            for chunk in texts
        ]


def _decode_bytes(payload: str) -> bytes:
    raw = (payload or "").strip()
    if not raw:
        return b""
    return base64.b64decode(raw)
