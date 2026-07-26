#!/usr/bin/env python3
"""Validate a Kross Cloud event envelope without importing TypeScript."""

import json
from pathlib import Path

from jsonschema import Draft7Validator


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
SCHEMA_PATH = (
    REPOSITORY_ROOT
    / "docs"
    / "schemas"
    / "kross-event-envelope-v1.schema.json"
)
EVENT_PATH = Path(__file__).with_name("event-envelope.json")


def main() -> None:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    event = json.loads(EVENT_PATH.read_text(encoding="utf-8"))
    Draft7Validator.check_schema(schema)
    Draft7Validator(schema).validate(event)
    print(
        f"valid Kross protocol v{event['protocolVersion']} "
        f"event seq={event['seq']}"
    )


if __name__ == "__main__":
    main()
