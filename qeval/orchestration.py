"""Orquestração, paralelismo, resume e checkpoint do benchmark."""

from __future__ import annotations

import concurrent.futures
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from qeval.errors import EvaluationError
from qeval.execution import _execute_work_item
from qeval.execution_config import prepare_execution_config, preflight
from qeval.executor import ExecuteFunction, _make_executor
from qeval.fingerprint import _attach_execution_profile
from qeval.manifest import _build_work_items, _result_key, build_execution_manifest
from qeval.persistence import (
    _atomic_write_json,
    _load_checkpoint,
    _reserved_ambiguous_calls,
    _validate_result_counts,
)
from qeval.reporting import build_summary


def run_benchmark(
    config_path: Path,
    config: dict[str, Any],
    dataset: dict[str, Any],
    routes: list[str],
    repetitions: int,
    parallel: int,
    max_calls: int,
    seed: int = 42,
    execute: ExecuteFunction | None = None,
    progress: bool = False,
    checkpoint_path: Path | None = None,
    resume: bool = False,
    retry_ambiguous: bool = False,
    selection: dict[str, list[str]] | None = None,
) -> dict[str, Any]:
    manifest = build_execution_manifest(
        config_path, config, dataset, routes, repetitions, seed, selection
    )
    call_count = manifest["physical_call_count"]
    if call_count > max_calls:
        raise EvaluationError(
            f"benchmark exigiria {call_count} chamadas, acima de --max-calls={max_calls}"
        )
    selected_cases = [
        case
        for case in dataset["cases"]
        if selection is None or case["id"] in selection
    ]
    route_roles = {
        route: {
            case["role"]
            for case in selected_cases
            if selection is None or route in selection.get(case["id"], [])
        }
        for route in routes
    }
    roles = {case["role"] for case in selected_cases}
    assertion_types = {
        assertion["type"]
        for case in selected_cases
        for assertion in case["assertions"]
    }
    execution_config, safety_adjustments = prepare_execution_config(
        config, routes, roles, route_roles
    )
    metadata = (
        preflight(execution_config, routes, roles, assertion_types, route_roles)
        if execute is None
        else {
            "safe_argv": {
                (route, role): None
                for route, selected_roles in route_roles.items()
                for role in selected_roles
            },
            "cli_versions": {},
        }
    )
    _attach_execution_profile(
        manifest, execution_config, safety_adjustments, metadata["cli_versions"]
    )
    executor_function = execute or _make_executor(execution_config)
    work_items = _build_work_items(dataset, routes, repetitions, seed, selection)
    slot_definitions = {slot["key"]: slot for slot in manifest["slots"]}
    checkpoint: dict[str, Any] | None = None
    resumed_slots = 0
    ambiguous_retries = 0
    if checkpoint_path is not None:
        checkpoint_path = checkpoint_path.expanduser().resolve()
        if checkpoint_path.exists():
            if not resume:
                raise EvaluationError(
                    f"checkpoint já existe; use --resume para retomar: {checkpoint_path}"
                )
            checkpoint = _load_checkpoint(checkpoint_path)
            stored_manifest = checkpoint["manifest"]
            stored_fingerprint = stored_manifest.get("execution_fingerprint")
            if not isinstance(stored_fingerprint, dict):
                raise EvaluationError(
                    "checkpoint legado sem execution_fingerprint; "
                    "retomada segura indisponível"
                )
            if stored_fingerprint.get("sha256") != manifest[
                "execution_fingerprint"
            ].get("sha256"):
                raise EvaluationError(
                    "checkpoint diverge do perfil efetivo, versões das CLIs ou engine"
                )
            if stored_manifest.get("plan_sha256") != manifest["plan_sha256"]:
                raise EvaluationError(
                    "checkpoint diverge da config, dataset, rubricas, rotas ou ordem atuais"
                )
            if set(checkpoint["slots"]) != set(slot_definitions):
                raise EvaluationError("checkpoint diverge das chaves de slot planejadas")
            changed = False
            for slot in checkpoint["slots"].values():
                if slot.get("state") == "running":
                    slot["state"] = "ambiguous"
                    slot["ambiguous_at"] = datetime.now(timezone.utc).isoformat()
                    changed = True
            if changed:
                checkpoint["updated_at"] = datetime.now(timezone.utc).isoformat()
                _atomic_write_json(checkpoint_path, checkpoint)
            ambiguous = [
                key
                for key, slot in checkpoint["slots"].items()
                if slot.get("state") == "ambiguous"
            ]
            historical_extra_budget = _reserved_ambiguous_calls(
                checkpoint, slot_definitions
            )
            required_budget = call_count + historical_extra_budget
            if required_budget > max_calls:
                raise EvaluationError(
                    "checkpoint com retries ambiguous já reservados exige "
                    f"--max-calls>={required_budget}"
                )
            if ambiguous and not retry_ambiguous:
                raise EvaluationError(
                    f"checkpoint contém {len(ambiguous)} slot(s) ambiguous; "
                    "use --retry-ambiguous e aumente --max-calls explicitamente"
                )
            if ambiguous:
                new_extra_budget = sum(
                    len(slot_definitions[key]["physical_call_keys"]) for key in ambiguous
                )
                required_budget += new_extra_budget
                if required_budget > max_calls:
                    raise EvaluationError(
                        f"retry de slots ambiguous exige --max-calls>={required_budget}"
                    )
                for key in ambiguous:
                    checkpoint["slots"][key]["state"] = "planned"
                    checkpoint["slots"][key]["ambiguous_retry_count"] = int(
                        checkpoint["slots"][key].get("ambiguous_retry_count", 0)
                    ) + 1
                checkpoint["max_calls"] = max_calls
                _atomic_write_json(checkpoint_path, checkpoint)
        else:
            if resume:
                raise EvaluationError(f"checkpoint não existe para --resume: {checkpoint_path}")
            checkpoint = {
                "version": 2,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat(),
                "max_calls": max_calls,
                "manifest": manifest,
                "slots": {
                    slot["key"]: {
                        "state": "planned",
                        "physical_call_keys": slot["physical_call_keys"],
                    }
                    for slot in manifest["slots"]
                },
                "results": [],
            }
            _atomic_write_json(checkpoint_path, checkpoint)
    elif resume or retry_ambiguous:
        raise EvaluationError("--resume e --retry-ambiguous exigem --checkpoint")

    indexed_results: dict[int, dict[str, Any]] = {}
    if checkpoint is not None:
        ambiguous_retries = sum(
            int(slot.get("ambiguous_retry_count", 0))
            for slot in checkpoint["slots"].values()
        )
        for result in checkpoint["results"]:
            key = _result_key(result["route"], result["case_id"], result["repetition"])
            definition = slot_definitions.get(key)
            if definition is None:
                raise EvaluationError(f"checkpoint contém resultado desconhecido: {key}")
            if checkpoint["slots"][key].get("state") != "completed":
                raise EvaluationError(f"checkpoint possui resultado fora de completed: {key}")
            if definition["item_index"] in indexed_results:
                raise EvaluationError(f"checkpoint possui resultado duplicado: {key}")
            indexed_results[definition["item_index"]] = result
        resumed_slots = len(indexed_results)

    def persist_slot_state(key: str, state: str) -> None:
        if checkpoint is None or checkpoint_path is None:
            return
        checkpoint["slots"][key]["state"] = state
        checkpoint["slots"][key][f"{state}_at"] = datetime.now(timezone.utc).isoformat()
        checkpoint["updated_at"] = datetime.now(timezone.utc).isoformat()
        checkpoint["results"] = [
            result for _, result in sorted(indexed_results.items())
        ]
        _atomic_write_json(checkpoint_path, checkpoint)

    def record_result(indexed_result: tuple[int, dict[str, Any]]) -> None:
        item_index, result = indexed_result
        indexed_results[item_index] = result
        key = _result_key(result["route"], result["case_id"], result["repetition"])
        persist_slot_state(key, "completed")
        if progress:
            completed = len(indexed_results)
            print(
                f"progresso: {completed}/{len(manifest['slots'])} slots "
                f"ordem={result['execution_order']} rota={result['route']} "
                f"caso={result['case_id']} repetição={result['repetition']} "
                f"status={result['status']} score={result['score']:.2f}%",
                file=sys.stderr,
                flush=True,
            )

    if parallel == 1:
        for position, (item_index, route, case, repetition) in enumerate(
            work_items, start=1
        ):
            key = _result_key(route, case["id"], repetition)
            if item_index in indexed_results:
                continue
            persist_slot_state(key, "running")
            record_result(
                _execute_work_item(
                    item_index,
                    position,
                    route,
                    case,
                    repetition,
                    executor_function,
                    metadata["safe_argv"][(route, case["role"])],
                    tuple(
                        canary
                        for canary in (dataset.get("canary"), case.get("canary"))
                        if canary
                    ),
                )
            )
    else:
        pending_items = iter(
            (
                position,
                item_index,
                route,
                case,
                repetition,
            )
            for position, (item_index, route, case, repetition) in enumerate(
                work_items, start=1
            )
            if item_index not in indexed_results
        )
        pool = concurrent.futures.ThreadPoolExecutor(max_workers=parallel)
        in_flight: dict[concurrent.futures.Future[Any], str] = {}

        def submit_next() -> bool:
            try:
                position, item_index, route, case, repetition = next(pending_items)
            except StopIteration:
                return False
            key = _result_key(route, case["id"], repetition)
            persist_slot_state(key, "running")
            try:
                future = pool.submit(
                    _execute_work_item,
                    item_index,
                    position,
                    route,
                    case,
                    repetition,
                    executor_function,
                    metadata["safe_argv"][(route, case["role"])],
                    tuple(
                        canary
                        for canary in (dataset.get("canary"), case.get("canary"))
                        if canary
                    ),
                )
            except BaseException:
                persist_slot_state(key, "planned")
                raise
            in_flight[future] = key
            return True

        try:
            while len(in_flight) < parallel and submit_next():
                pass
            while in_flight:
                completed, _ = concurrent.futures.wait(
                    tuple(in_flight),
                    return_when=concurrent.futures.FIRST_COMPLETED,
                )
                for future in completed:
                    in_flight.pop(future)
                    record_result(future.result())
                while len(in_flight) < parallel and submit_next():
                    pass
        except BaseException:
            for future, key in list(in_flight.items()):
                if future.cancel():
                    in_flight.pop(future)
                    persist_slot_state(key, "planned")
            raise
        finally:
            pool.shutdown(wait=True, cancel_futures=True)
    results = [result for _, result in sorted(indexed_results.items())]
    _validate_result_counts(
        results, routes, dataset["cases"], repetitions, selection
    )
    ambiguous_calls_reserved = (
        _reserved_ambiguous_calls(checkpoint, slot_definitions)
        if checkpoint is not None
        else 0
    )
    recorded_result_calls = sum(result.get("physical_calls", 1) for result in results)
    physical_call_accounting = "upper_bound" if ambiguous_calls_reserved else "exact"
    return {
        "version": 2,
        "scope": dataset.get("benchmark_scope", "production_executors"),
        "scope_note": (
            "Configured production CLI profiles are used with the explicit benchmark "
            "safety adjustments listed in safety_adjustments."
        ),
        "dataset_version": dataset["version"],
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "config": str(config_path),
        "config_sha256": manifest["config_sha256"],
        "dataset_sha256": manifest["dataset_sha256"],
        "rubric_sha256": manifest["rubric_sha256"],
        "order_sha256": manifest["order_sha256"],
        "base_plan_sha256": manifest["base_plan_sha256"],
        "plan_sha256": manifest["plan_sha256"],
        "execution_fingerprint": manifest["execution_fingerprint"],
        "cli_versions": metadata["cli_versions"],
        "safety_adjustments": safety_adjustments,
        "routes": routes,
        "selection": selection,
        "repetitions": repetitions,
        "parallel": parallel,
        "seed": seed,
        "calls": call_count,
        "recorded_result_calls": recorded_result_calls,
        "physical_call_accounting": physical_call_accounting,
        **(
            {"executed_calls": recorded_result_calls}
            if physical_call_accounting == "exact"
            else {}
        ),
        "max_calls": max_calls,
        "slot_count": len(manifest["slots"]),
        "resumed_slots": resumed_slots,
        "ambiguous_retries": ambiguous_retries,
        "ambiguous_calls_reserved": ambiguous_calls_reserved,
        "physical_calls_upper_bound": call_count + ambiguous_calls_reserved,
        "execution_order": manifest["slots"],
        "summary": build_summary(results),
        "results": results,
    }
