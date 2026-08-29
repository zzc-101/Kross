def mime_of(mime: str) -> str:
    return (mime or "").split(";", 1)[0].strip().lower()


def suffix_of(filename: str) -> str:
    name = (filename or "").lower()
    dot = name.rfind(".")
    return name[dot:] if dot >= 0 else ""


def is_pdf(*, filename: str, mime: str) -> bool:
    if mime_of(mime) == "application/pdf":
        return True
    return suffix_of(filename) == ".pdf"


def is_word(*, filename: str, mime: str) -> bool:
    type_name = mime_of(mime)
    if type_name in {
        "application/msword",
        "application/vnd.ms-word",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }:
        return True
    return suffix_of(filename) in {".doc", ".docx"}


def is_markdown(*, filename: str, mime: str) -> bool:
    type_name = mime_of(mime)
    if type_name in {"text/markdown", "text/plain", "text/x-markdown"}:
        return True
    return suffix_of(filename) in {".md", ".markdown", ".txt"}
