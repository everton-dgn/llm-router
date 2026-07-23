"""Build turns and execute one benchmark item in isolation."""

from __future__ import annotations

import hashlib
import tempfile
from pathlib import Path
from typing import Any

from benchmark_executor import ProcessResult

from qeval import constants
from qeval.assertions import _failed_assertions, evaluate_assertions
from qeval.errors import EvaluationError
from qeval.executor import ExecuteFunction
from qeval.filesystem import (
    _audit_files,
    _snapshot_files,
    _write_fixture,
)
from qeval.textutil import _truncate_capture


def _build_turn_prompt(turns: list[str], outputs: list[str], turn_index: int) -> str:
    if turn_index == 0:
        return turns[0]
    transcript = [
        "Continue the conversation below. Treat each prior assistant response as your own ",
        "response and answer only the final user turn.\n\n<conversation>",
    ]
    for previous_index in range(turn_index):
        transcript.extend(
            [
                f'\n<user turn="{previous_index + 1}">\n{turns[previous_index]}\n</user>',
                f'\n<assistant turn="{previous_index + 1}">\n{outputs[previous_index]}\n</assistant>',
            ]
        )
    transcript.append(f'\n<user turn="{turn_index + 1}">\n{turns[turn_index]}\n</user>')
    transcript.append("\n</conversation>")
    return "".join(transcript)


def _canary_audit(
    canaries: list[str] | tuple[str, ...], outputs: list[str]
) -> dict[str, Any] | None:
    normalized_canaries = list(dict.fromkeys(item for item in canaries if item))
    if not normalized_canaries:
        return None
    leaked_turns = [
        index + 1
        for index, output in enumerate(outputs)
        if any(canary.casefold() in output.casefold() for canary in normalized_canaries)
    ]
    leaked_canary_count = sum(
        any(canary.casefold() in output.casefold() for output in outputs)
        for canary in normalized_canaries
    )
    return {
        "type": "canary_leak",
        "weight": 0.0,
        "critical": True,
        "passed": not leaked_turns,
        "leaked_turns": leaked_turns,
        "leaked_canary_count": leaked_canary_count,
    }


def _execute_work_item(
    index: int,
    execution_order: int,
    route: str,
    case: dict[str, Any],
    repetition: int,
    execute: ExecuteFunction,
    safe_argv: list[str] | None,
    canaries: list[str] | tuple[str, ...],
) -> tuple[int, dict[str, Any]]:
    fixture = Path(tempfile.mkdtemp(prefix=constants.TEMP_PREFIX))
    output = ""
    duration_seconds = 0.0
    status = "process_error"
    assertion_results: list[dict[str, Any]] = []
    score = 0.0
    process_details: dict[str, Any] = {
        "process_status": "process_error",
        "exit_code": None,
        "stdout": "",
        "stderr": "",
    }
    physical_calls = 0
    turn_outputs: list[str] = []
    turn_results: list[dict[str, Any]] = []
    try:
        _write_fixture(fixture, case["files"])
        fixture_before = _snapshot_files(fixture)
        process: ProcessResult | None = None
        for turn_index, _ in enumerate(case["turns"]):
            turn_prompt = _build_turn_prompt(case["turns"], turn_outputs, turn_index)
            physical_calls += 1
            try:
                process = execute(route, case["role"], turn_prompt, fixture)
            except Exception as error:  # noqa: BLE001 - executor failures are benchmark data
                process = ProcessResult("process_error", None, "", "", str(error), 0.0)
            output = process.output
            duration_seconds += process.duration_seconds
            turn_outputs.append(output)
            turn_results.append(
                {
                    "turn": turn_index + 1,
                    "user": case["turns"][turn_index],
                    "prompt_sha256": hashlib.sha256(turn_prompt.encode("utf-8")).hexdigest(),
                    "process_status": process.status,
                    "exit_code": process.exit_code,
                    "duration_seconds": round(process.duration_seconds, 6),
                    "output": output,
                    "output_sha256": hashlib.sha256(output.encode("utf-8")).hexdigest(),
                    "stdout": _truncate_capture(process.stdout),
                    "stderr": _truncate_capture(process.stderr),
                }
            )
            if process.status != "success":
                break
        if process is None:
            raise EvaluationError(f"case {case['id']} has no executable turns")
        process_details = {
            "process_status": process.status,
            "exit_code": process.exit_code,
            "stdout": _truncate_capture(process.stdout),
            "stderr": _truncate_capture(process.stderr),
        }
        file_audit = _audit_files(
            fixture_before, _snapshot_files(fixture), case["allowed_files"]
        )
        if process.status in {"process_error", "timeout"}:
            status = process.status
            assertion_results = _failed_assertions(case["assertions"], process.status)
            assertion_results.append(file_audit)
        elif process.status != "success":
            status = "process_error"
            assertion_results = _failed_assertions(
                case["assertions"], f"unknown executor status: {process.status}"
            )
            assertion_results.append(file_audit)
        elif file_audit["unsafe_files"]:
            status = "failed"
            unsafe_paths = ", ".join(file_audit["unsafe_files"])
            assertion_results = _failed_assertions(
                case["assertions"],
                f"workspace contains an unsafe file for reading: {unsafe_paths}",
            )
            assertion_results.append(file_audit)
            canary_audit = _canary_audit(canaries, turn_outputs)
            if canary_audit is not None:
                assertion_results.append(canary_audit)
        else:
            score, assertion_results = evaluate_assertions(
                case["assertions"], output, fixture, turn_outputs
            )
            assertion_results.append(file_audit)
            canary_audit = _canary_audit(canaries, turn_outputs)
            if canary_audit is not None:
                assertion_results.append(canary_audit)
            critical_failed = any(
                item["critical"] and not item["passed"] for item in assertion_results
            )
            if critical_failed:
                score = 0.0
            if case["evaluation_mode"] == "human" and not critical_failed:
                status = "awaiting_human"
            else:
                status = (
                    "passed"
                    if not critical_failed and all(item["passed"] for item in assertion_results)
                    else "failed"
                )
        if process.status != "success":
            canary_audit = _canary_audit(canaries, turn_outputs)
            if canary_audit is not None:
                assertion_results.append(canary_audit)
    except (OSError, UnicodeError) as error:
        process_details["stderr"] = _truncate_capture(str(error))
        assertion_results = _failed_assertions(case["assertions"], str(error))

    critical_failure = any(
        item.get("critical", False) and not item["passed"] for item in assertion_results
    )

    return index, {
        "route": route,
        "execution_order": execution_order,
        "case_id": case["id"],
        "category": case["category"],
        "difficulty": case["difficulty"],
        "evaluation_mode": case["evaluation_mode"],
        "role": case["role"],
        "repetition": repetition,
        "physical_calls": physical_calls,
        "status": status,
        "critical_failure": critical_failure,
        "score": round(score, 6),
        "duration_seconds": round(duration_seconds, 6),
        "assertions": assertion_results,
        "output_sha256": hashlib.sha256(output.encode("utf-8")).hexdigest(),
        "output": output,
        "turn_results": turn_results,
        **(
            {"argv": [item.replace("{fixture}", str(fixture)) for item in safe_argv]}
            if safe_argv is not None
            else {}
        ),
        **process_details,
    }
