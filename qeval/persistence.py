"""Atomic writes, checkpoints, and result-count validation."""

from __future__ import annotations

import json
import os
import tempfile
from collections import Counter
from pathlib import Path
from typing import Any

from qeval.errors import EvaluationError


def _atomic_write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary_path = Path(temporary_name)
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary_path, path)


def _load_checkpoint(path: Path) -> dict[str, Any]:
    try:
        with path.open(encoding="utf-8") as stream:
            checkpoint = json.load(stream)
    except OSError as error:
        raise EvaluationError(f"could not read checkpoint: {error}") from error
    except json.JSONDecodeError as error:
        raise EvaluationError(f"invalid checkpoint JSON: {error}") from error
    if (
        not isinstance(checkpoint, dict)
        or checkpoint.get("version") != 2
        or not isinstance(checkpoint.get("manifest"), dict)
        or not isinstance(checkpoint.get("slots"), dict)
        or not isinstance(checkpoint.get("results"), list)
    ):
        raise EvaluationError("checkpoint has an invalid format")
    return checkpoint


def _reserved_ambiguous_calls(
    checkpoint: dict[str, Any], slot_definitions: dict[str, dict[str, Any]]
) -> int:
    total = 0
    for key, slot in checkpoint["slots"].items():
        retry_count = slot.get("ambiguous_retry_count", 0)
        if (
            not isinstance(retry_count, int)
            or isinstance(retry_count, bool)
            or retry_count < 0
        ):
            raise EvaluationError(
                f"checkpoint has an invalid ambiguous_retry_count in slot {key}"
            )
        total += retry_count * len(slot_definitions[key]["physical_call_keys"])
    return total


def _validate_result_counts(
    results: list[dict[str, Any]],
    routes: list[str],
    cases: list[dict[str, Any]],
    repetitions: int,
    selection: dict[str, list[str]] | None = None,
) -> None:
    expected = {
        (route, case["id"], repetition)
        for route in routes
        for case in cases
        if selection is None or route in selection.get(case["id"], [])
        for repetition in range(1, repetitions + 1)
    }
    actual = Counter(
        (result["route"], result["case_id"], result["repetition"]) for result in results
    )
    if set(actual) != expected or any(count != 1 for count in actual.values()):
        raise EvaluationError("final result count differs from planned slots")
