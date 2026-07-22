"""Avaliação de assertions individuais."""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from typing import Any

from benchmark_executor import parse_json_object

from qeval import sandbox
from qeval.errors import EvaluationError
from qeval.textutil import (
    _json_path,
    _json_path_values,
    _regex_result,
    _reject_non_json_constant,
    _truncate_capture,
)


def _evaluate_assertion(
    assertion: dict[str, Any], output: str, cwd: Path, turn_outputs: list[str] | None = None
) -> dict[str, Any]:
    kind = assertion["type"]
    result: dict[str, Any] = {
        "type": kind,
        "weight": assertion["weight"],
        "critical": assertion["critical"],
        "passed": False,
    }
    try:
        selected_output = output
        if "turn" in assertion:
            turn_index = assertion["turn"] - 1
            if turn_outputs is None or turn_index >= len(turn_outputs):
                raise KeyError(f"turn {assertion['turn']}")
            selected_output = turn_outputs[turn_index]
        if kind in {"output_json_equals", "output_json_one_of"}:
            parsed = parse_json_object(selected_output)
            actual = _json_path(parsed, assertion["path"])
            expected = assertion["expected"]
            result.update(
                {
                    "passed": (
                        actual == expected
                        if kind == "output_json_equals"
                        else any(actual == candidate for candidate in expected)
                    ),
                    "path": assertion["path"],
                    "expected": expected,
                    "actual": actual,
                }
            )
        elif kind == "output_strict_json_object":
            try:
                parsed_strict = json.loads(
                    selected_output, parse_constant=_reject_non_json_constant
                )
            except (json.JSONDecodeError, ValueError) as error:
                result.update(
                    {
                        "passed": False,
                        "error": f"JSON estrito inválido: {error}",
                    }
                )
            else:
                result.update(
                    {
                        "passed": isinstance(parsed_strict, dict),
                        "actual_type": type(parsed_strict).__name__,
                    }
                )
        elif kind in {"output_regex", "output_not_regex"}:
            matched = _regex_result(assertion["pattern"], selected_output)
            result.update(
                {
                    "passed": matched if kind == "output_regex" else not matched,
                    "pattern": assertion["pattern"],
                    "matched": matched,
                }
            )
        elif kind == "output_regex_count":
            count = len(list(re.finditer(assertion["pattern"], selected_output, re.MULTILINE)))
            result.update(
                {
                    "passed": assertion["minimum"] <= count <= assertion["maximum"],
                    "pattern": assertion["pattern"],
                    "minimum": assertion["minimum"],
                    "maximum": assertion["maximum"],
                    "actual": count,
                }
            )
        elif kind == "output_all_patterns":
            matches = {
                pattern: _regex_result(pattern, selected_output)
                for pattern in assertion["patterns"]
            }
            result.update(
                {
                    "passed": all(matches.values()),
                    "patterns": assertion["patterns"],
                    "matches": matches,
                }
            )
        elif kind in {"file_regex", "file_not_regex"}:
            content = sandbox._read_regular_text(cwd, assertion["file"])
            matched = _regex_result(assertion["pattern"], content)
            result.update(
                {
                    "passed": matched if kind == "file_regex" else not matched,
                    "file": assertion["file"],
                    "pattern": assertion["pattern"],
                    "matched": matched,
                }
            )
        elif kind == "file_regex_count":
            content = sandbox._read_regular_text(cwd, assertion["file"])
            count = len(list(re.finditer(assertion["pattern"], content, re.MULTILINE)))
            result.update(
                {
                    "passed": assertion["minimum"] <= count <= assertion["maximum"],
                    "file": assertion["file"],
                    "pattern": assertion["pattern"],
                    "minimum": assertion["minimum"],
                    "maximum": assertion["maximum"],
                    "actual": count,
                }
            )
        elif kind in {
            "output_character_count_range",
            "output_word_count_range",
            "output_json_number_range",
        }:
            parsed = parse_json_object(selected_output)
            values = _json_path_values(parsed, assertion["path"])
            if kind == "output_character_count_range":
                actual = [len(value) if isinstance(value, str) else None for value in values]
            elif kind == "output_word_count_range":
                actual = [
                    len(re.findall(r"\b[\w'-]+\b", value, flags=re.UNICODE))
                    if isinstance(value, str)
                    else None
                    for value in values
                ]
            else:
                actual = [
                    float(value)
                    if isinstance(value, (int, float)) and not isinstance(value, bool)
                    else None
                    for value in values
                ]
            passed = all(
                value is not None and assertion["minimum"] <= value <= assertion["maximum"]
                for value in actual
            )
            result.update(
                {
                    "passed": passed,
                    "path": assertion["path"],
                    "minimum": assertion["minimum"],
                    "maximum": assertion["maximum"],
                    "actual": actual,
                }
            )
        elif kind in {"output_json_length", "output_json_length_range"}:
            parsed = parse_json_object(selected_output)
            values = _json_path_values(parsed, assertion["path"])
            target = values if "[*]" in assertion["path"] else values[0]
            actual = len(target)
            if kind == "output_json_length":
                passed = actual == assertion["expected"]
                expected_details = {"expected": assertion["expected"]}
            else:
                passed = assertion["minimum"] <= actual <= assertion["maximum"]
                expected_details = {
                    "minimum": assertion["minimum"],
                    "maximum": assertion["maximum"],
                }
            result.update(
                {"passed": passed, "path": assertion["path"], "actual": actual, **expected_details}
            )
        elif kind == "output_json_all_lengths":
            parsed = parse_json_object(selected_output)
            values = _json_path_values(parsed, assertion["path"])
            actual = [len(value) if hasattr(value, "__len__") else None for value in values]
            result.update(
                {
                    "passed": all(value == assertion["expected"] for value in actual),
                    "path": assertion["path"],
                    "expected": assertion["expected"],
                    "actual": actual,
                }
            )
        elif kind in {"output_json_non_empty", "output_json_all_non_empty_values"}:
            parsed = parse_json_object(selected_output)
            target = _json_path(parsed, assertion["path"])
            if kind == "output_json_non_empty":
                values = [target]
            elif isinstance(target, dict):
                values = list(target.values())
            elif isinstance(target, list):
                values = target
            else:
                values = [target]
            non_empty = [
                value is not None
                and (not isinstance(value, (str, list, dict, tuple, set)) or len(value) > 0)
                for value in values
            ]
            result.update(
                {
                    "passed": bool(values) and all(non_empty),
                    "path": assertion["path"],
                    "non_empty": non_empty,
                }
            )
        elif kind == "output_json_sum_max":
            parsed = parse_json_object(selected_output)
            values = _json_path_values(parsed, assertion["path"])
            if not all(
                isinstance(value, (int, float)) and not isinstance(value, bool)
                for value in values
            ):
                raise ValueError("todos os valores precisam ser numéricos")
            actual = sum(float(value) for value in values)
            result.update(
                {
                    "passed": actual <= assertion["maximum"],
                    "path": assertion["path"],
                    "maximum": assertion["maximum"],
                    "actual": actual,
                }
            )
        elif kind == "output_json_values_in":
            parsed = parse_json_object(selected_output)
            values = _json_path_values(parsed, assertion["path"])
            result.update(
                {
                    "passed": all(value in assertion["allowed"] for value in values),
                    "path": assertion["path"],
                    "allowed": assertion["allowed"],
                    "actual": values,
                }
            )
        elif kind == "output_json_all_match":
            parsed = parse_json_object(selected_output)
            values = _json_path_values(parsed, assertion["path"])
            required = set(assertion["required_keys"])
            missing = [
                sorted(required - set(value)) if isinstance(value, dict) else sorted(required)
                for value in values
            ]
            result.update(
                {
                    "passed": all(not item for item in missing),
                    "path": assertion["path"],
                    "required_keys": assertion["required_keys"],
                    "missing_by_item": missing,
                }
            )
        elif kind == "output_json_all_non_empty":
            parsed = parse_json_object(selected_output)
            values = _json_path_values(parsed, assertion["path"])

            def is_non_empty(value: Any) -> bool:
                if value is None:
                    return False
                if isinstance(value, (str, list, dict, tuple, set)):
                    return len(value) > 0
                return True

            missing = [
                [
                    key
                    for key in assertion["required_keys"]
                    if not isinstance(value, dict)
                    or key not in value
                    or not is_non_empty(value[key])
                ]
                for value in values
            ]
            result.update(
                {
                    "passed": all(not item for item in missing),
                    "path": assertion["path"],
                    "required_keys": assertion["required_keys"],
                    "empty_or_missing_by_item": missing,
                }
            )
        elif kind == "output_json_all_patterns":
            parsed = parse_json_object(selected_output)
            values = _json_path_values(parsed, assertion["path"])
            matches = {
                pattern: all(
                    isinstance(value, str) and _regex_result(pattern, value)
                    for value in values
                )
                for pattern in assertion["patterns"]
            }
            result.update(
                {
                    "passed": all(matches.values()),
                    "path": assertion["path"],
                    "patterns": assertion["patterns"],
                    "matches": matches,
                }
            )
        elif kind == "output_json_ends_with_path":
            parsed = parse_json_object(selected_output)
            text_value = _json_path(parsed, assertion["text_path"])
            suffix_value = _json_path(parsed, assertion["suffix_path"])
            values_are_strings = isinstance(text_value, str) and isinstance(suffix_value, str)
            non_empty_ok = not assertion["require_non_empty"] or bool(suffix_value)
            result.update(
                {
                    "passed": (
                        values_are_strings
                        and non_empty_ok
                        and text_value.endswith(suffix_value)
                    ),
                    "text_path": assertion["text_path"],
                    "suffix_path": assertion["suffix_path"],
                    "require_non_empty": assertion["require_non_empty"],
                }
            )
        elif kind == "output_json_last_item_regex":
            parsed = parse_json_object(selected_output)
            values = _json_path(parsed, assertion["path"])
            if not isinstance(values, list) or not values:
                raise ValueError("path precisa apontar para uma lista não vazia")
            last_item = values[-1]
            matched = isinstance(last_item, str) and _regex_result(
                assertion["pattern"], last_item
            )
            result.update(
                {
                    "passed": matched,
                    "path": assertion["path"],
                    "pattern": assertion["pattern"],
                    "matched": matched,
                }
            )
        elif kind == "output_unique_values":
            parsed = parse_json_object(selected_output)
            values = _json_path_values(parsed, assertion["path"])
            unique_count = len(
                {json.dumps(value, ensure_ascii=False, sort_keys=True) for value in values}
            )
            result.update(
                {
                    "passed": unique_count >= assertion["minimum_unique"],
                    "path": assertion["path"],
                    "minimum_unique": assertion["minimum_unique"],
                    "actual": unique_count,
                }
            )
        elif kind == "output_each_regex":
            parsed = parse_json_object(selected_output)
            actual: dict[str, bool] = {}
            for path in assertion["paths"]:
                values = _json_path_values(parsed, path)
                actual[path] = all(
                    isinstance(value, str) and _regex_result(assertion["pattern"], value)
                    for value in values
                )
            result.update(
                {
                    "passed": all(actual.values()),
                    "paths": assertion["paths"],
                    "pattern": assertion["pattern"],
                    "actual": actual,
                }
            )
        elif kind == "output_hashtag_count_max":
            parsed = parse_json_object(selected_output)
            actual: dict[str, list[int]] = {}
            for path in assertion["paths"]:
                values = _json_path_values(parsed, path)
                actual[path] = [
                    len(re.findall(r"(?<!\w)#[\w]+", value, flags=re.UNICODE))
                    if isinstance(value, str)
                    else assertion["maximum"] + 1
                    for value in values
                ]
            result.update(
                {
                    "passed": all(
                        count <= assertion["maximum"]
                        for counts in actual.values()
                        for count in counts
                    ),
                    "paths": assertion["paths"],
                    "maximum": assertion["maximum"],
                    "actual": actual,
                }
            )
        elif kind == "python_behavior":
            result.update(sandbox._evaluate_python_behavior(assertion, cwd))
        elif kind == "python_test_mutants":
            result.update(sandbox._evaluate_python_test_mutants(assertion, cwd))
        elif kind == "command":
            result.update(sandbox._evaluate_sandboxed_command(assertion, cwd))
    except subprocess.TimeoutExpired as error:
        result["error"] = f"comando excedeu {assertion['timeout_seconds']} segundos"
        result["stdout"] = _truncate_capture(error.stdout or "")
        result["stderr"] = _truncate_capture(error.stderr or "")
    except (EvaluationError, KeyError, OSError, UnicodeError, ValueError, re.error) as error:
        result["error"] = str(error)
    return result


def evaluate_assertions(
    assertions: list[dict[str, Any]],
    output: str,
    cwd: Path,
    turn_outputs: list[str] | None = None,
) -> tuple[float, list[dict[str, Any]]]:
    results = [
        _evaluate_assertion(assertion, output, cwd, turn_outputs) for assertion in assertions
    ]
    if not results:
        return 0.0, []
    total_weight = sum(item["weight"] for item in results)
    approved_weight = sum(item["weight"] for item in results if item["passed"])
    return 100.0 * approved_weight / total_weight, results


def _failed_assertions(
    assertions: list[dict[str, Any]], reason: str
) -> list[dict[str, Any]]:
    return [
        {
            "type": assertion["type"],
            "weight": assertion["weight"],
            "critical": assertion["critical"],
            "passed": False,
            "error": reason,
        }
        for assertion in assertions
    ]
