import shutil
import subprocess
import tempfile
from io import BytesIO

import olefile
from docx import Document

from parsers.detect import suffix_of


def parse_word(*, filename: str, mime: str, data: bytes) -> str:
    payload = data or b""
    if not payload:
        raise ValueError("Word document is empty")
    if _looks_like_docx(filename, payload):
        return parse_docx(payload)
    return parse_doc(payload)


def parse_docx(data: bytes) -> str:
    try:
        document = Document(BytesIO(data))
    except Exception as error:
        raise ValueError("Failed to parse .docx") from error
    parts: list[str] = []
    for paragraph in document.paragraphs:
        text = (paragraph.text or "").strip()
        if text:
            parts.append(text)
    for table in document.tables:
        for row in table.rows:
            cells = [cell.text.strip() for cell in row.cells if (cell.text or "").strip()]
            if cells:
                parts.append("\t".join(cells))
    body = "\n\n".join(parts).strip()
    if not body:
        raise ValueError("Word document has no extractable text")
    return body


def parse_doc(data: bytes) -> str:
    extracted = _ole_text(data)
    if extracted:
        return extracted
    via_antiword = _antiword(data)
    if via_antiword:
        return via_antiword
    raise ValueError("Failed to extract text from .doc; save as .docx and retry")


def _looks_like_docx(filename: str, data: bytes) -> bool:
    if suffix_of(filename) == ".docx":
        return True
    return data.startswith(b"PK")


def _antiword(data: bytes) -> str:
    binary = shutil.which("antiword")
    if not binary:
        return ""
    with tempfile.NamedTemporaryFile(suffix=".doc") as tmp:
        tmp.write(data)
        tmp.flush()
        result = subprocess.run(
            [binary, tmp.name],
            check=False,
            capture_output=True,
        )
    text = (result.stdout or b"").decode("utf-8", errors="replace").strip()
    return text


def _ole_text(data: bytes) -> str:
    buffer = BytesIO(data)
    if not olefile.isOleFile(buffer):
        return ""
    buffer.seek(0)
    ole = olefile.OleFileIO(buffer)
    parts: list[str] = []
    try:
        for stream in ole.listdir():
            name = "/".join(stream).lower()
            if "worddocument" not in name and "table" not in name:
                continue
            raw = ole.openstream(stream).read()
            text = _utf16_runs(raw)
            if text:
                parts.append(text)
    finally:
        ole.close()
    return "\n\n".join(parts).strip()


def _utf16_runs(blob: bytes, min_chars: int = 6) -> str:
    runs: list[str] = []
    index = 0
    size = len(blob)
    while index + 1 < size:
        chars: list[str] = []
        cursor = index
        while cursor + 1 < size:
            code = blob[cursor] | (blob[cursor + 1] << 8)
            if _usable_codepoint(code):
                chars.append("\n" if code in {10, 13} else (" " if code == 9 else chr(code)))
                cursor += 2
                continue
            break
        if len(chars) >= min_chars:
            run = "".join(chars).strip()
            if run:
                runs.append(run)
            index = cursor + 2
        else:
            index += 2
    return "\n".join(runs)


def _usable_codepoint(code: int) -> bool:
    if code in {9, 10, 13}:
        return True
    if 32 <= code <= 126:
        return True
    if 0x4E00 <= code <= 0x9FFF:
        return True
    if 0x3400 <= code <= 0x4DBF:
        return True
    if 0x3000 <= code <= 0x303F:
        return True
    if 0xFF00 <= code <= 0xFFEF:
        return True
    return False

