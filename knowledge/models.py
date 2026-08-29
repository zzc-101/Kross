from pydantic import BaseModel, Field


class IngestRequest(BaseModel):
    document_id: str
    space_id: str
    title: str
    filename: str
    mime: str
    text: str = ""
    file_base64: str = ""
    image_base64: str = ""
    source_key: str = ""


class IngestResponse(BaseModel):
    document_id: str
    job_id: str
    status: str
    chunk_count: int = 0
    error_message: str | None = None


class PublishRequest(BaseModel):
    published: bool = True


class PublishResponse(BaseModel):
    document_id: str
    published: bool
    chunk_count: int


class SearchRequest(BaseModel):
    query: str
    space_ids: list[str] = Field(default_factory=list)
    top_k: int = 8
    published_only: bool = True


class SearchHit(BaseModel):
    document_id: str
    title: str
    space_id: str
    excerpt: str
    score: float
    modality: str = "text"


class SearchResponse(BaseModel):
    hits: list[SearchHit]


class JobResponse(BaseModel):
    id: str
    document_id: str
    kind: str
    status: str
    error_message: str | None = None
