from io import BytesIO

from pypdf import PdfReader


def parse_pdf(data: bytes) -> str:
    payload = data or b""
    if not payload:
        raise ValueError("PDF is empty")
    try:
        reader = PdfReader(BytesIO(payload))
    except Exception as error:
        raise ValueError("Failed to parse PDF") from error
    if reader.is_encrypted:
        raise ValueError("Encrypted PDF is not supported")
    pages: list[str] = []
    for page in reader.pages:
        extracted = (page.extract_text() or "").strip()
        if extracted:
            pages.append(extracted)
    if not pages:
        raise ValueError("PDF has no extractable text layer; scanned PDFs are not supported yet")
    return "\n\n".join(pages)
