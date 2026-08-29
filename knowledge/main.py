from fastapi import FastAPI, Header, HTTPException

from models import IngestRequest, PublishRequest, SearchRequest
from service import KnowledgeService
from settings import load_settings

settings = load_settings()
pipeline = KnowledgeService(settings)
app = FastAPI(title="kross-knowledge", version="0.1.0")


def _authorize(token: str | None) -> None:
    expected = settings.internal_token.strip()
    if not expected:
        return
    if (token or "").strip() != expected:
        raise HTTPException(status_code=401, detail="invalid knowledge token")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/v1/ingest")
def ingest(
    request: IngestRequest,
    x_kross_knowledge_token: str | None = Header(default=None),
):
    _authorize(x_kross_knowledge_token)
    return pipeline.ingest(request)


@app.post("/v1/documents/{document_id}/publish")
def publish(
    document_id: str,
    body: PublishRequest | None = None,
    x_kross_knowledge_token: str | None = Header(default=None),
):
    _authorize(x_kross_knowledge_token)
    published = True if body is None else body.published
    return pipeline.publish(document_id, PublishRequest(published=published))


@app.post("/v1/search")
def search(
    request: SearchRequest,
    x_kross_knowledge_token: str | None = Header(default=None),
):
    _authorize(x_kross_knowledge_token)
    query = (request.query or "").strip()
    if not query:
        raise HTTPException(status_code=400, detail="query is required")
    return pipeline.search(request)


@app.get("/v1/jobs/{job_id}")
def job(
    job_id: str,
    x_kross_knowledge_token: str | None = Header(default=None),
):
    _authorize(x_kross_knowledge_token)
    found = pipeline.job(job_id)
    if found is None:
        raise HTTPException(status_code=404, detail="job not found")
    return found
