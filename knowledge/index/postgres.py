import re
from uuid import uuid4

from pgvector.psycopg import register_vector
from psycopg import connect
from psycopg.rows import dict_row

from index.base import ChunkRecord, SearchHit

_RRF_K = 60


class PostgresIndex:
    def __init__(self, database_url: str) -> None:
        self._url = database_url

    def replace_document(self, document_id: str, chunks: list[ChunkRecord]) -> None:
        with connect(self._url, row_factory=dict_row) as conn:
            register_vector(conn)
            with conn.cursor() as cur:
                cur.execute("DELETE FROM knowledge_chunks WHERE document_id = %s", (document_id,))
                for chunk in chunks:
                    cur.execute(
                        """
                        INSERT INTO knowledge_chunks
                          (id, document_id, space_id, title, body, modality, source_key, published, embedding)
                        VALUES
                          (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                        """,
                        (
                            str(uuid4()),
                            chunk.document_id,
                            chunk.space_id,
                            chunk.title,
                            chunk.text,
                            chunk.modality,
                            chunk.source_key or None,
                            chunk.published,
                            chunk.embedding,
                        ),
                    )
            conn.commit()

    def set_published(self, document_id: str, published: bool) -> int:
        with connect(self._url, row_factory=dict_row) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE knowledge_chunks
                    SET published = %s
                    WHERE document_id = %s
                    """,
                    (published, document_id),
                )
                count = cur.rowcount
            conn.commit()
            return count

    def search(
        self,
        query: str,
        query_embedding: list[float],
        space_ids: list[str],
        top_k: int,
        published_only: bool,
    ) -> list[SearchHit]:
        fetch = max(top_k * 4, 20)
        with connect(self._url, row_factory=dict_row) as conn:
            register_vector(conn)
            with conn.cursor() as cur:
                vector_rows = _fetch_vector(
                    cur, query_embedding, space_ids, published_only, fetch
                )
                lexical_rows = _fetch_lexical(cur, query, space_ids, published_only, fetch)
        merged = _rrf(vector_rows, lexical_rows)
        return merged[: max(top_k, 1)]


def _fetch_vector(cur, query_embedding, space_ids, published_only, fetch):
    sql = """
        SELECT id, document_id, space_id, title, body, modality
        FROM knowledge_chunks
        WHERE (%s = false OR published = true)
          AND (cardinality(%s::text[]) = 0 OR space_id = ANY(%s))
        ORDER BY embedding <=> %s
        LIMIT %s
    """
    cur.execute(sql, (published_only, space_ids, space_ids, query_embedding, fetch))
    return cur.fetchall()


def _fetch_lexical(cur, query, space_ids, published_only, fetch):
    tokens = _tokens(query)
    if not tokens:
        return []
    like_clauses = " OR ".join(["(body ILIKE %s OR title ILIKE %s)"] * len(tokens))
    params: list = [published_only, space_ids, space_ids]
    for token in tokens:
        pattern = f"%{token}%"
        params.extend([pattern, pattern])
    params.append(fetch)
    sql = f"""
        SELECT id, document_id, space_id, title, body, modality
        FROM knowledge_chunks
        WHERE (%s = false OR published = true)
          AND (cardinality(%s::text[]) = 0 OR space_id = ANY(%s))
          AND ({like_clauses})
        LIMIT %s
    """
    cur.execute(sql, params)
    return cur.fetchall()


def _rrf(vector_rows, lexical_rows) -> list[SearchHit]:
    scores: dict[str, float] = {}
    rows: dict[str, dict] = {}
    for rank, row in enumerate(vector_rows, start=1):
        key = row["id"]
        rows[key] = row
        scores[key] = scores.get(key, 0.0) + 1.0 / (_RRF_K + rank)
    for rank, row in enumerate(lexical_rows, start=1):
        key = row["id"]
        rows[key] = row
        scores[key] = scores.get(key, 0.0) + 1.0 / (_RRF_K + rank)
    ordered = sorted(scores.items(), key=lambda item: item[1], reverse=True)
    hits: list[SearchHit] = []
    for key, score in ordered:
        row = rows[key]
        body = row.get("body") or ""
        modality = row.get("modality") or "text"
        excerpt = body if modality == "text" else (body or f"[图片] {row.get('title') or ''}")
        hits.append(
            SearchHit(
                document_id=row["document_id"],
                title=row["title"],
                space_id=row["space_id"],
                excerpt=excerpt[:280],
                score=score,
                modality=modality,
            )
        )
    return hits


def _tokens(text: str) -> list[str]:
    return [match.group(0).lower() for match in re.finditer(r"[\w\u4e00-\u9fff]+", text or "")]
