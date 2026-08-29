import argparse

from embedding import ensure_local_model
from settings import Settings


def main() -> None:
    parser = argparse.ArgumentParser(description="Download embedding weights for the knowledge service")
    parser.add_argument("--model", default="", help="model id; empty uses KNOWLEDGE_EMBEDDING_SIZE/MODEL")
    parser.add_argument("--size", default="", help="default-family size: 2b, 4b, or 9b")
    parser.add_argument("--dir", default="./models/embeddings", help="local directory to store weights")
    parser.add_argument(
        "--hub",
        default="huggingface",
        choices=["huggingface", "modelscope", "modelspace"],
        help="download source",
    )
    args = parser.parse_args()
    updates: dict[str, str] = {}
    if args.size:
        updates["embedding_size"] = args.size
    if args.model:
        updates["embedding_model"] = args.model
    settings = Settings().model_copy(update=updates)
    spec = settings.embedding_spec()
    path = ensure_local_model(model_id=spec.model_id, model_dir=args.dir, hub=args.hub)
    print(path)


if __name__ == "__main__":
    main()
