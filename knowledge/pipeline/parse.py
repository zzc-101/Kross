from parsers.detect import is_markdown, is_pdf, is_word
from parsers.image import is_image
from parsers.markdown import split_markdown
from parsers.office import parse_word
from parsers.pdf import parse_pdf


def parse_document(*, filename: str, mime: str, text: str, data: bytes = b"") -> str:
    if is_image(filename=filename, mime=mime):
        return ""
    if is_pdf(filename=filename, mime=mime):
        return parse_pdf(data)
    if is_word(filename=filename, mime=mime):
        return parse_word(filename=filename, mime=mime, data=data)
    if is_markdown(filename=filename, mime=mime) or text:
        return text or ""
    raise ValueError("Unsupported document type")


def chunk_document(*, filename: str, mime: str, text: str, data: bytes = b"") -> list[str]:
    if is_image(filename=filename, mime=mime):
        return []
    extracted = parse_document(filename=filename, mime=mime, text=text, data=data)
    return split_markdown(extracted)
