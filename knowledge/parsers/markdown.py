def parse_markdown(text: str) -> list[str]:
    return split_markdown(text)


def split_markdown(text: str, max_chars: int = 1200) -> list[str]:
    body = (text or "").strip()
    if not body:
        return []
    blocks = [part.strip() for part in body.split("\n\n") if part.strip()]
    chunks: list[str] = []
    current = ""
    for block in blocks:
        if current and len(current) + 2 + len(block) > max_chars:
            chunks.append(current)
            current = block
            continue
        current = block if not current else f"{current}\n\n{block}"
    if current:
        chunks.append(current)
    return chunks
