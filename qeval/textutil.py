"""Helpers textuais: truncamento, JSON path, regex e serialização/hash."""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any

from qeval import constants


def _truncate_capture(value: str | bytes, limit: int = constants.MAX_CAPTURE_CHARS) -> str:
    if isinstance(value, bytes):
        value = value.decode("utf-8", errors="replace")
    if len(value) <= limit:
        return value
    return value[:limit] + "\n[conteúdo truncado pelo benchmark]"


def _json_path_values(value: Any, dotted_path: str) -> list[Any]:
    segments = dotted_path.replace("[*]", ".*").split(".")
    current = [value]
    for segment in segments:
        next_values: list[Any] = []
        for item in current:
            if segment == "*" and isinstance(item, list):
                next_values.extend(item)
            elif isinstance(item, dict) and segment in item:
                next_values.append(item[segment])
            elif isinstance(item, list) and segment.isdigit():
                index = int(segment)
                if index < len(item):
                    next_values.append(item[index])
        if not next_values:
            raise KeyError(segment)
        current = next_values
    return current


def _json_path(value: Any, dotted_path: str) -> Any:
    values = _json_path_values(value, dotted_path)
    if "[*]" in dotted_path:
        return values
    if len(values) != 1:
        raise KeyError(dotted_path)
    return values[0]


def _regex_result(pattern: str, value: str) -> bool:
    return re.search(pattern, value, flags=re.MULTILINE) is not None


def _reject_non_json_constant(value: str) -> None:
    raise ValueError(f"constante não permitida em JSON estrito: {value}")


def _sha256_json(value: Any) -> str:
    encoded = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()
