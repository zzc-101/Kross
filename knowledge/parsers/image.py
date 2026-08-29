IMAGE_MIMES = {
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/gif",
    "image/webp",
}

IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp"}


def is_image(*, filename: str, mime: str) -> bool:
    lowered = (mime or "").strip().lower()
    if lowered in IMAGE_MIMES:
        return True
    name = (filename or "").lower()
    return any(name.endswith(suffix) for suffix in IMAGE_SUFFIXES)
