"""Work items, manifesto de execução e contagem de chamadas físicas."""

from __future__ import annotations

import json
import random
from pathlib import Path
from typing import Any

from qeval.errors import EvaluationError
from qeval import fingerprint
from qeval.textutil import _sha256_json


def _result_key(route: str, case_id: str, repetition: int) -> str:
    return json.dumps([route, case_id, repetition], ensure_ascii=False, separators=(",", ":"))


def planned_call_count(
    routes: list[str],
    cases: list[dict[str, Any]],
    repetitions: int,
    selection: dict[str, list[str]] | None = None,
) -> int:
    return repetitions * sum(
        len(case["turns"])
        for route in routes
        for case in cases
        if selection is None or route in selection.get(case["id"], [])
    )


def _build_work_items(
    dataset: dict[str, Any],
    routes: list[str],
    repetitions: int,
    seed: int,
    selection: dict[str, list[str]] | None = None,
) -> list[tuple[int, str, dict[str, Any], int]]:
    work_items: list[tuple[int, str, dict[str, Any], int]] = []
    index = 0
    for route in routes:
        for case in dataset["cases"]:
            if selection is not None and route not in selection.get(case["id"], []):
                continue
            for repetition in range(1, repetitions + 1):
                work_items.append((index, route, case, repetition))
                index += 1
    random.Random(seed).shuffle(work_items)
    return work_items


def build_execution_manifest(
    config_path: Path,
    config: dict[str, Any],
    dataset: dict[str, Any],
    routes: list[str],
    repetitions: int,
    seed: int,
    selection: dict[str, list[str]] | None = None,
) -> dict[str, Any]:
    work_items = _build_work_items(dataset, routes, repetitions, seed, selection)
    slots: list[dict[str, Any]] = []
    physical_call_keys: list[str] = []
    for position, (item_index, route, case, repetition) in enumerate(work_items, start=1):
        slot_key = _result_key(route, case["id"], repetition)
        call_keys = [
            json.dumps(
                [route, case["id"], repetition, turn],
                ensure_ascii=False,
                separators=(",", ":"),
            )
            for turn in range(1, len(case["turns"]) + 1)
        ]
        physical_call_keys.extend(call_keys)
        slots.append(
            {
                "key": slot_key,
                "item_index": item_index,
                "position": position,
                "route": route,
                "case_id": case["id"],
                "category": case["category"],
                "difficulty": case["difficulty"],
                "role": case["role"],
                "repetition": repetition,
                "physical_call_keys": call_keys,
            }
        )
    if len({slot["key"] for slot in slots}) != len(slots):
        raise EvaluationError("manifesto contém chaves de slot duplicadas")
    if len(set(physical_call_keys)) != len(physical_call_keys):
        raise EvaluationError("manifesto contém chaves de chamada física duplicadas")
    expected_calls = planned_call_count(
        routes, dataset["cases"], repetitions, selection
    )
    if len(physical_call_keys) != expected_calls:
        raise EvaluationError("manifesto diverge da contagem de chamadas físicas")

    config_hash = fingerprint._config_sha256(config_path, config)
    dataset_hash = _sha256_json(dataset)
    rubric_hash = fingerprint._rubric_sha256(dataset)
    order_hash = _sha256_json(slots)
    plan_basis = {
        "config_sha256": config_hash,
        "dataset_sha256": dataset_hash,
        "rubric_sha256": rubric_hash,
        "order_sha256": order_hash,
        "routes": routes,
        "repetitions": repetitions,
        "seed": seed,
        "selection": selection,
        "planned_calls": expected_calls,
    }
    return {
        "version": 2,
        **plan_basis,
        "plan_sha256": _sha256_json(plan_basis),
        "slot_count": len(slots),
        "physical_call_count": len(physical_call_keys),
        "physical_call_keys": physical_call_keys,
        "slots": slots,
    }
