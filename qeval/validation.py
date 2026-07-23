"""Normalize and validate datasets, routes, and selections."""

from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Any

from qeval import constants
from qeval.errors import EvaluationError


def _non_empty_string(value: Any, path: str) -> str:
    if not isinstance(value, str) or not value:
        raise EvaluationError(f"{path} must be a non-empty string")
    return value


def _positive_int(value: Any, path: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise EvaluationError(f"{path} must be a positive integer")
    return value


def _positive_or_zero_int(value: Any, path: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise EvaluationError(f"{path} must be an integer greater than or equal to zero")
    return value


def _finite_number(value: Any, path: str) -> float:
    if (
        not isinstance(value, (int, float))
        or isinstance(value, bool)
        or not math.isfinite(float(value))
    ):
        raise EvaluationError(f"{path} must be a finite number")
    return float(value)


def _safe_relative_path(value: Any, path: str) -> str:
    raw = _non_empty_string(value, path)
    candidate = Path(raw)
    if candidate == Path(".") or candidate.is_absolute() or ".." in candidate.parts:
        raise EvaluationError(f"{path} must point to a safe relative path")
    return raw


def _assertion_type(assertion: dict[str, Any], path: str) -> str:
    if assertion.get("type") == "python_hidden_tests" or "python_hidden_tests" in assertion:
        raise EvaluationError(
            f"{path}.type python_hidden_tests was removed; use python_behavior"
        )
    explicit = assertion.get("type")
    compact = [name for name in constants.ASSERTION_TYPES if name in assertion]
    if explicit is not None:
        kind = _non_empty_string(explicit, f"{path}.type")
        if compact and any(name != kind for name in compact):
            raise EvaluationError(f"{path} mixes assertion types")
    elif len(compact) == 1:
        kind = compact[0]
    else:
        raise EvaluationError(f"{path} must declare exactly one assertion type")
    if kind not in constants.ASSERTION_TYPES:
        raise EvaluationError(f"unknown {path}.type: {kind}")
    return kind


def _normalized_sandboxed_command_argv(value: Any, path: str) -> list[str]:
    if (
        not isinstance(value, list)
        or not value
        or not all(isinstance(item, str) for item in value)
    ):
        raise EvaluationError(f"{path} must be a non-empty list of strings")
    argv = list(value)
    if argv[: len(constants.SANDBOXED_COMMAND_PREFIX)] != constants.SANDBOXED_COMMAND_PREFIX:
        raise EvaluationError(
            f"{path} is disabled outside the safe prefix "
            "uv run --no-project --no-python-downloads python"
        )
    payload = argv[len(constants.SANDBOXED_COMMAND_PREFIX) :]
    if len(payload) == 1:
        script = _safe_relative_path(payload[0], f"{path}[5]")
        if Path(script).suffix != ".py":
            raise EvaluationError(f"{path} accepts only a relative Python script or -c")
    elif len(payload) == 2 and payload[0] == "-c":
        _non_empty_string(payload[1], f"{path}[6]")
    else:
        raise EvaluationError(
            f"{path} accepts only a relative Python script or -c after the safe prefix"
        )
    return argv


def _safe_python_symbol_path(value: Any, path: str) -> str:
    raw = _non_empty_string(value, path)
    segments = raw.split(".")
    if any(
        not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", segment)
        or "__" in segment
        for segment in segments
    ):
        raise EvaluationError(
            f"{path} must contain only Python identifiers without dunder access"
        )
    return raw


def _json_serializable_value(value: Any, path: str) -> Any:
    try:
        json.dumps(value, ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError) as error:
        raise EvaluationError(f"{path} must be JSON-serializable") from error
    return value


def _normalized_assertion(assertion: Any, path: str) -> dict[str, Any]:
    if not isinstance(assertion, dict):
        raise EvaluationError(f"{path} must be an object")
    result = dict(assertion)
    kind = _assertion_type(result, path)
    compact_payload = result.get(kind)
    if compact_payload is not None:
        if isinstance(compact_payload, dict):
            for key, value in compact_payload.items():
                result.setdefault(key, value)
        elif kind in {"output_regex", "output_not_regex"}:
            result.setdefault("pattern", compact_payload)
        elif kind in {"file_regex", "file_not_regex"}:
            raise EvaluationError(f"{path}.{kind} must be an object")
        elif kind == "command":
            result.setdefault("argv", compact_payload)
        elif kind not in {"output_json_equals", "output_json_one_of"}:
            raise EvaluationError(f"{path}.{kind} must be an object")
    result["type"] = kind

    weight = result.get("weight", 1)
    if (
        not isinstance(weight, (int, float))
        or isinstance(weight, bool)
        or not math.isfinite(float(weight))
        or weight <= 0
    ):
        raise EvaluationError(f"{path}.weight must be a positive finite number")
    result["weight"] = float(weight)
    critical = result.get("critical", False)
    if not isinstance(critical, bool):
        raise EvaluationError(f"{path}.critical must be a boolean")
    result["critical"] = critical
    if "turn" in result:
        turn = result["turn"]
        if not isinstance(turn, int) or isinstance(turn, bool) or turn not in {1, 2}:
            raise EvaluationError(f"{path}.turn must be 1 or 2")

    if kind in {"output_json_equals", "output_json_one_of"}:
        result["path"] = _non_empty_string(result.get("path"), f"{path}.path")
        if "expected" not in result:
            raise EvaluationError(f"{path}.expected is required")
        if kind == "output_json_one_of" and (
            not isinstance(result["expected"], list) or not result["expected"]
        ):
            raise EvaluationError(f"{path}.expected must be a non-empty list")
    elif kind in {"output_regex", "output_not_regex"}:
        result["pattern"] = _non_empty_string(result.get("pattern"), f"{path}.pattern")
    elif kind in {"file_regex", "file_not_regex"}:
        file_path = result.get("file", result.get("path"))
        result["file"] = _safe_relative_path(file_path, f"{path}.file")
        result["pattern"] = _non_empty_string(result.get("pattern"), f"{path}.pattern")
    elif kind == "file_regex_count":
        result["file"] = _safe_relative_path(
            result.get("file", result.get("path")), f"{path}.file"
        )
        result["pattern"] = _non_empty_string(result.get("pattern"), f"{path}.pattern")
        result["minimum"] = _positive_or_zero_int(result.get("minimum"), f"{path}.minimum")
        result["maximum"] = _positive_or_zero_int(result.get("maximum"), f"{path}.maximum")
        if result["minimum"] > result["maximum"]:
            raise EvaluationError(f"{path}.minimum must be less than or equal to maximum")
    elif kind in {"output_regex_count"}:
        result["pattern"] = _non_empty_string(result.get("pattern"), f"{path}.pattern")
        result["minimum"] = _positive_or_zero_int(result.get("minimum"), f"{path}.minimum")
        result["maximum"] = _positive_or_zero_int(result.get("maximum"), f"{path}.maximum")
        if result["minimum"] > result["maximum"]:
            raise EvaluationError(f"{path}.minimum must be less than or equal to maximum")
    elif kind in {
        "output_character_count_range",
        "output_json_length_range",
        "output_json_number_range",
        "output_word_count_range",
    }:
        result["path"] = _non_empty_string(result.get("path"), f"{path}.path")
        result["minimum"] = _finite_number(result.get("minimum"), f"{path}.minimum")
        result["maximum"] = _finite_number(result.get("maximum"), f"{path}.maximum")
        if result["minimum"] > result["maximum"]:
            raise EvaluationError(f"{path}.minimum must be less than or equal to maximum")
    elif kind == "output_json_length":
        result["path"] = _non_empty_string(result.get("path"), f"{path}.path")
        result["expected"] = _positive_or_zero_int(result.get("expected"), f"{path}.expected")
    elif kind == "output_json_all_lengths":
        result["path"] = _non_empty_string(result.get("path"), f"{path}.path")
        result["expected"] = _positive_or_zero_int(result.get("expected"), f"{path}.expected")
    elif kind in {"output_json_non_empty", "output_json_all_non_empty_values"}:
        result["path"] = _non_empty_string(result.get("path"), f"{path}.path")
    elif kind in {"output_json_sum_max"}:
        result["path"] = _non_empty_string(result.get("path"), f"{path}.path")
        result["maximum"] = _finite_number(result.get("maximum"), f"{path}.maximum")
    elif kind == "output_unique_values":
        result["path"] = _non_empty_string(result.get("path"), f"{path}.path")
        result["minimum_unique"] = _positive_int(
            result.get("minimum_unique"), f"{path}.minimum_unique"
        )
    elif kind == "output_json_values_in":
        result["path"] = _non_empty_string(result.get("path"), f"{path}.path")
        allowed = result.get("allowed")
        if not isinstance(allowed, list) or not allowed:
            raise EvaluationError(f"{path}.allowed must be a non-empty list")
        result["allowed"] = allowed
    elif kind == "output_json_all_match":
        result["path"] = _non_empty_string(result.get("path"), f"{path}.path")
        required_keys = result.get("required_keys")
        if (
            not isinstance(required_keys, list)
            or not required_keys
            or not all(isinstance(item, str) and item for item in required_keys)
        ):
            raise EvaluationError(f"{path}.required_keys must be a list of strings")
        result["required_keys"] = required_keys
    elif kind == "output_json_all_non_empty":
        result["path"] = _non_empty_string(result.get("path"), f"{path}.path")
        required_keys = result.get("required_keys")
        if (
            not isinstance(required_keys, list)
            or not required_keys
            or not all(isinstance(item, str) and item for item in required_keys)
        ):
            raise EvaluationError(f"{path}.required_keys must be a list of strings")
        result["required_keys"] = required_keys
    elif kind in {"output_all_patterns", "output_json_all_patterns"}:
        if kind == "output_json_all_patterns":
            result["path"] = _non_empty_string(result.get("path"), f"{path}.path")
        patterns = result.get("patterns")
        if (
            not isinstance(patterns, list)
            or not patterns
            or not all(isinstance(item, str) and item for item in patterns)
        ):
            raise EvaluationError(f"{path}.patterns must be a list of strings")
        result["patterns"] = patterns
    elif kind == "output_json_ends_with_path":
        result["text_path"] = _non_empty_string(
            result.get("text_path"), f"{path}.text_path"
        )
        result["suffix_path"] = _non_empty_string(
            result.get("suffix_path"), f"{path}.suffix_path"
        )
        require_non_empty = result.get("require_non_empty", False)
        if not isinstance(require_non_empty, bool):
            raise EvaluationError(f"{path}.require_non_empty must be a boolean")
        result["require_non_empty"] = require_non_empty
    elif kind == "output_json_last_item_regex":
        result["path"] = _non_empty_string(result.get("path"), f"{path}.path")
        result["pattern"] = _non_empty_string(result.get("pattern"), f"{path}.pattern")
    elif kind in {"output_each_regex", "output_hashtag_count_max"}:
        paths = result.get("paths")
        if (
            not isinstance(paths, list)
            or not paths
            or not all(isinstance(item, str) and item for item in paths)
        ):
            raise EvaluationError(f"{path}.paths must be a list of strings")
        result["paths"] = paths
        if kind == "output_each_regex":
            result["pattern"] = _non_empty_string(result.get("pattern"), f"{path}.pattern")
        else:
            result["maximum"] = _positive_or_zero_int(
                result.get("maximum"), f"{path}.maximum"
            )
    elif kind == "python_behavior":
        raw_probes = result.get("probes")
        if not isinstance(raw_probes, list) or not raw_probes:
            raise EvaluationError(f"{path}.probes must be a non-empty list")
        probes: list[dict[str, Any]] = []
        probe_ids: set[str] = set()
        for probe_index, raw_probe in enumerate(raw_probes):
            probe_path = f"{path}.probes[{probe_index}]"
            if not isinstance(raw_probe, dict):
                raise EvaluationError(f"{probe_path} must be an object")
            probe_id = _non_empty_string(raw_probe.get("id"), f"{probe_path}.id")
            if probe_id in probe_ids:
                raise EvaluationError(f"{path}.probes has a duplicate id: {probe_id}")
            probe_ids.add(probe_id)
            args = raw_probe.get("args", [])
            kwargs = raw_probe.get("kwargs", {})
            if not isinstance(args, list):
                raise EvaluationError(f"{probe_path}.args must be a list")
            if not isinstance(kwargs, dict) or not all(
                isinstance(key, str) for key in kwargs
            ):
                raise EvaluationError(
                    f"{probe_path}.kwargs must be an object with string keys"
                )
            has_return = "expected_return" in raw_probe
            has_type = "expected_type" in raw_probe
            has_exception = "expected_exception" in raw_probe
            if has_exception and (has_return or has_type):
                raise EvaluationError(
                    f"{probe_path} cannot combine expected_exception with a return value or type"
                )
            if not has_exception and not (has_return or has_type):
                raise EvaluationError(
                    f"{probe_path} must declare expected_return, expected_type, or expected_exception"
                )
            probe: dict[str, Any] = {
                "id": probe_id,
                "module": _safe_python_symbol_path(
                    raw_probe.get("module"), f"{probe_path}.module"
                ),
                "call": _safe_python_symbol_path(
                    raw_probe.get("call"), f"{probe_path}.call"
                ),
                "args": _json_serializable_value(args, f"{probe_path}.args"),
                "kwargs": _json_serializable_value(kwargs, f"{probe_path}.kwargs"),
            }
            if has_return:
                probe["expected_return"] = _json_serializable_value(
                    raw_probe["expected_return"], f"{probe_path}.expected_return"
                )
            if has_type:
                probe["expected_type"] = _safe_python_symbol_path(
                    raw_probe["expected_type"], f"{probe_path}.expected_type"
                )
            if has_exception:
                probe["expected_exception"] = _safe_python_symbol_path(
                    raw_probe["expected_exception"], f"{probe_path}.expected_exception"
                )
            probes.append(probe)
        result["probes"] = probes
        timeout = result.get("timeout_seconds", 10)
        result["timeout_seconds"] = _finite_number(timeout, f"{path}.timeout_seconds")
        if result["timeout_seconds"] <= 0 or result["timeout_seconds"] > 30:
            raise EvaluationError(f"{path}.timeout_seconds must be between 0 and 30")
    elif kind == "python_test_mutants":
        result["test_file"] = _safe_relative_path(
            result.get("test_file"), f"{path}.test_file"
        )
        result["module_file"] = _safe_relative_path(
            result.get("module_file"), f"{path}.module_file"
        )
        raw_mutants = result.get("mutants")
        if not isinstance(raw_mutants, list) or not raw_mutants:
            raise EvaluationError(f"{path}.mutants must be a non-empty list")
        mutants: list[dict[str, str]] = []
        mutant_ids: set[str] = set()
        for mutant_index, raw_mutant in enumerate(raw_mutants):
            mutant_path = f"{path}.mutants[{mutant_index}]"
            if not isinstance(raw_mutant, dict):
                raise EvaluationError(f"{mutant_path} must be an object")
            mutant_id = _non_empty_string(raw_mutant.get("id"), f"{mutant_path}.id")
            if mutant_id in mutant_ids:
                raise EvaluationError(f"{path} has a duplicate mutant id: {mutant_id}")
            mutant_ids.add(mutant_id)
            mutants.append(
                {
                    "id": mutant_id,
                    "content": _non_empty_string(
                        raw_mutant.get("content"), f"{mutant_path}.content"
                    ),
                }
            )
        result["mutants"] = mutants
        timeout = result.get("timeout_seconds", 10)
        result["timeout_seconds"] = _finite_number(timeout, f"{path}.timeout_seconds")
        if result["timeout_seconds"] <= 0 or result["timeout_seconds"] > 30:
            raise EvaluationError(f"{path}.timeout_seconds must be between 0 and 30")
    elif kind == "command":
        result["argv"] = _normalized_sandboxed_command_argv(
            result.get("argv"), f"{path}.argv"
        )
        expected_exit = result.get("expected_exit", 0)
        if not isinstance(expected_exit, int) or isinstance(expected_exit, bool):
            raise EvaluationError(f"{path}.expected_exit must be an integer")
        timeout = result.get("timeout_seconds", 30)
        timeout = _finite_number(timeout, f"{path}.timeout_seconds")
        if timeout <= 0 or timeout > 30:
            raise EvaluationError(f"{path}.timeout_seconds must be between 0 and 30")
        result["expected_exit"] = expected_exit
        result["timeout_seconds"] = timeout
    return result


def _normalized_human_evaluation(value: Any, path: str) -> dict[str, Any] | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise EvaluationError(f"{path} must be an object")
    result: dict[str, Any] = {}
    for key in (
        "blind",
        "randomize_output_order",
        "pairwise_comparison",
        "retain_rationales",
    ):
        raw_flag = value.get(key)
        if not isinstance(raw_flag, bool):
            raise EvaluationError(f"{path}.{key} must be a boolean")
        result[key] = raw_flag
    raw_scale = value.get("dimension_scale")
    if not isinstance(raw_scale, dict):
        raise EvaluationError(f"{path}.dimension_scale must be an object")
    minimum = _finite_number(
        raw_scale.get("minimum"), f"{path}.dimension_scale.minimum"
    )
    maximum = _finite_number(
        raw_scale.get("maximum"), f"{path}.dimension_scale.maximum"
    )
    if minimum >= maximum:
        raise EvaluationError(
            f"{path}.dimension_scale.minimum must be less than maximum"
        )
    result["dimension_scale"] = {"minimum": minimum, "maximum": maximum}
    return result


def _normalized_human_rubric(
    value: Any, path: str, default_scale: dict[str, float] | None = None
) -> dict[str, Any]:
    if isinstance(value, list):
        raw_criteria = value
        raw_scale: Any = default_scale or {"min": 1, "max": 5}
        instructions = None
    elif isinstance(value, dict):
        raw_criteria = value.get("criteria")
        raw_scale = value.get("scale")
        instructions = value.get("instructions")
    else:
        raise EvaluationError(f"{path} must be an object or a list")
    if not isinstance(raw_criteria, list) or not raw_criteria:
        raise EvaluationError(f"{path}.criteria must be a non-empty list")
    criteria: list[dict[str, Any]] = []
    criterion_ids: set[str] = set()
    for index, raw_criterion in enumerate(raw_criteria):
        criterion_path = f"{path}.criteria[{index}]"
        if not isinstance(raw_criterion, dict):
            raise EvaluationError(f"{criterion_path} must be an object")
        criterion_id = _non_empty_string(
            raw_criterion.get("id", raw_criterion.get("dimension")),
            f"{criterion_path}.id",
        )
        if criterion_id in criterion_ids:
            raise EvaluationError(f"{path} has a duplicate criterion: {criterion_id}")
        criterion_ids.add(criterion_id)
        criteria.append(
            {
                "id": criterion_id,
                "description": _non_empty_string(
                    raw_criterion.get("description"), f"{criterion_path}.description"
                ),
                "weight": _finite_number(raw_criterion.get("weight"), f"{criterion_path}.weight"),
            }
        )
        if criteria[-1]["weight"] <= 0:
            raise EvaluationError(f"{criterion_path}.weight must be positive")
    weight_sum = sum(criterion["weight"] for criterion in criteria)
    if not math.isclose(weight_sum, 100.0, abs_tol=1e-6):
        raise EvaluationError(f"{path}.criteria weights must total 100")

    if not isinstance(raw_scale, dict):
        raise EvaluationError(f"{path}.scale must be an object")
    scale_min = _finite_number(raw_scale.get("min"), f"{path}.scale.min")
    scale_max = _finite_number(raw_scale.get("max"), f"{path}.scale.max")
    if scale_min >= scale_max:
        raise EvaluationError(f"{path}.scale.min must be less than scale.max")
    result: dict[str, Any] = {
        "criteria": criteria,
        "scale": {"min": scale_min, "max": scale_max},
    }
    if instructions is not None:
        result["instructions"] = _non_empty_string(
            instructions, f"{path}.instructions"
        )
    return result


def validate_dataset(raw: Any) -> dict[str, Any]:
    """Validate and normalize a version 1 or version 2 quality dataset."""
    if not isinstance(raw, dict):
        raise EvaluationError("dataset must be a JSON object")
    dataset_version = raw.get("version")
    if dataset_version not in constants.SUPPORTED_DATASET_VERSIONS:
        supported = ", ".join(str(version) for version in sorted(constants.SUPPORTED_DATASET_VERSIONS))
        raise EvaluationError(f"dataset.version must be one of these values: {supported}")
    raw_canary = raw.get("canary")
    canary = (
        _non_empty_string(raw_canary, "dataset.canary") if raw_canary is not None else None
    )
    benchmark_scope = raw.get("benchmark_scope", "production_executors")
    if dataset_version == 2:
        benchmark_scope = _non_empty_string(benchmark_scope, "dataset.benchmark_scope")
        human_evaluation = _normalized_human_evaluation(
            raw.get("human_evaluation"), "dataset.human_evaluation"
        )
    else:
        human_evaluation = None
    rubric_default_scale = (
        {
            "min": human_evaluation["dimension_scale"]["minimum"],
            "max": human_evaluation["dimension_scale"]["maximum"],
        }
        if human_evaluation is not None
        else None
    )
    raw_cases = raw.get("cases")
    if not isinstance(raw_cases, list) or not raw_cases:
        raise EvaluationError("dataset.cases must be a non-empty list")

    case_ids: set[str] = set()
    cases: list[dict[str, Any]] = []
    for case_index, raw_case in enumerate(raw_cases):
        case_path = f"dataset.cases[{case_index}]"
        if not isinstance(raw_case, dict):
            raise EvaluationError(f"{case_path} must be an object")
        case_id = _non_empty_string(raw_case.get("id"), f"{case_path}.id")
        if case_id in case_ids:
            raise EvaluationError(f"duplicate case id: {case_id}")
        case_ids.add(case_id)
        category = _non_empty_string(raw_case.get("category"), f"{case_path}.category")
        raw_case_canary = raw_case.get("canary")
        case_canary = (
            _non_empty_string(raw_case_canary, f"{case_path}.canary")
            if raw_case_canary is not None
            else None
        )
        if dataset_version == 1:
            turns = [_non_empty_string(raw_case.get("prompt"), f"{case_path}.prompt")]
            difficulty = "legacy"
            evaluation_mode = "objective"
            human_rubric = None
        else:
            difficulty = _non_empty_string(
                raw_case.get("difficulty"), f"{case_path}.difficulty"
            )
            if difficulty not in constants.DIFFICULTIES:
                allowed = ", ".join(sorted(constants.DIFFICULTIES))
                raise EvaluationError(
                    f"{case_path}.difficulty must be one of these values: {allowed}"
                )
            evaluation_mode = _non_empty_string(
                raw_case.get("evaluation_mode"), f"{case_path}.evaluation_mode"
            )
            if evaluation_mode not in constants.EVALUATION_MODES:
                allowed = ", ".join(sorted(constants.EVALUATION_MODES))
                raise EvaluationError(
                    f"{case_path}.evaluation_mode must be one of these values: {allowed}"
                )
            has_prompt = "prompt" in raw_case
            has_turns = "turns" in raw_case
            if has_prompt == has_turns:
                raise EvaluationError(
                    f"{case_path} must declare exactly one of prompt and turns"
                )
            if has_prompt:
                turns = [_non_empty_string(raw_case.get("prompt"), f"{case_path}.prompt")]
            else:
                raw_turns = raw_case.get("turns")
                if not isinstance(raw_turns, list) or len(raw_turns) not in {1, 2}:
                    raise EvaluationError(f"{case_path}.turns must contain 1 or 2 turns")
                turns = []
                for turn_index, raw_turn in enumerate(raw_turns):
                    turn_path = f"{case_path}.turns[{turn_index}]"
                    if not isinstance(raw_turn, dict):
                        raise EvaluationError(f"{turn_path} must be an object")
                    turn_value = raw_turn.get("user", raw_turn.get("prompt"))
                    turns.append(_non_empty_string(turn_value, f"{turn_path}.prompt"))
            raw_human_rubric = raw_case.get("human_rubric")
            if raw_human_rubric == [] and evaluation_mode == "objective":
                human_rubric = None
            elif raw_human_rubric is not None:
                human_rubric = _normalized_human_rubric(
                    raw_human_rubric,
                    f"{case_path}.human_rubric",
                    rubric_default_scale,
                )
            elif evaluation_mode in {"human", "hybrid"}:
                human_rubric = _normalized_human_rubric(
                    raw_human_rubric,
                    f"{case_path}.human_rubric",
                    rubric_default_scale,
                )
            else:
                human_rubric = None
        prompt = turns[0]
        role = raw_case.get("role", "judge")
        if role not in {"judge", "worker"}:
            raise EvaluationError(f"{case_path}.role must be judge or worker")
        raw_files = raw_case.get("files", {})
        if not isinstance(raw_files, dict):
            raise EvaluationError(f"{case_path}.files must be an object")
        files: dict[str, str] = {}
        for file_path, content in raw_files.items():
            normalized_path = _safe_relative_path(file_path, f"{case_path}.files")
            if not isinstance(content, str):
                raise EvaluationError(f"{case_path}.files[{file_path}] must be a string")
            files[normalized_path] = content
        raw_allowed_files = raw_case.get("allowed_files", [])
        if not isinstance(raw_allowed_files, list) or not all(
            isinstance(item, str) for item in raw_allowed_files
        ):
            raise EvaluationError(f"{case_path}.allowed_files must be a list of strings")
        allowed_files = [
            _safe_relative_path(item, f"{case_path}.allowed_files[{allowed_index}]")
            for allowed_index, item in enumerate(raw_allowed_files)
        ]
        raw_assertions = raw_case.get("assertions", [])
        assertions_required = dataset_version == 1 or evaluation_mode in {"objective", "hybrid"}
        if not isinstance(raw_assertions, list) or (assertions_required and not raw_assertions):
            requirement = "a non-empty list" if assertions_required else "a list"
            raise EvaluationError(f"{case_path}.assertions must be {requirement}")
        assertions = [
            _normalized_assertion(item, f"{case_path}.assertions[{assertion_index}]")
            for assertion_index, item in enumerate(raw_assertions)
        ]
        cases.append(
            {
                "id": case_id,
                "category": category,
                "prompt": prompt,
                "turns": turns,
                "difficulty": difficulty,
                "evaluation_mode": evaluation_mode,
                "human_rubric": human_rubric,
                "canary": case_canary,
                "role": role,
                "files": files,
                "allowed_files": allowed_files,
                "assertions": assertions,
            }
        )
    return {
        "version": dataset_version,
        "benchmark_scope": benchmark_scope,
        "canary": canary,
        "human_evaluation": human_evaluation,
        "cases": cases,
    }


def load_dataset(path: Path) -> dict[str, Any]:
    try:
        with path.open(encoding="utf-8") as stream:
            raw = json.load(stream)
    except OSError as error:
        raise EvaluationError(f"could not read dataset: {error}") from error
    except json.JSONDecodeError as error:
        raise EvaluationError(f"invalid dataset JSON: {error}") from error
    return validate_dataset(raw)


def validate_routes(
    config: dict[str, Any], requested: list[str] | None, required_roles: set[str] | None = None
) -> list[str]:
    raw_routes = config.get("routes")
    if not isinstance(raw_routes, list) or not raw_routes:
        raise EvaluationError("config.routes must be a non-empty list")
    if requested is not None:
        if not requested:
            raise EvaluationError("--routes must contain at least one route")
        if len(set(requested)) != len(requested):
            raise EvaluationError("--routes contains a duplicate route")
    requested_names = set(requested or [])
    roles_to_validate = {"worker"} if required_roles is None else required_roles
    available: list[str] = []
    for index, route in enumerate(raw_routes):
        if not isinstance(route, dict):
            raise EvaluationError(f"config.routes[{index}] must be an object")
        name = _non_empty_string(route.get("name"), f"config.routes[{index}].name")
        if name in available:
            raise EvaluationError(f"duplicate route in config: {name}")
        headless = route.get("headless")
        if not isinstance(headless, dict):
            raise EvaluationError(f"route {name} has no routes[].headless")
        if requested is None or name in requested_names:
            for role in roles_to_validate:
                if not isinstance(headless.get(role), dict):
                    raise EvaluationError(
                        f"route {name} has no routes[].headless.{role}"
                    )
        available.append(name)
    if requested is None:
        return available
    selected: list[str] = []
    for name in requested:
        if name not in available:
            raise EvaluationError(f"unknown route in --routes: {name}")
        selected.append(name)
    return selected


def parse_routes(value: str | None) -> list[str] | None:
    if value is None:
        return None
    routes = [item.strip() for item in value.split(",")]
    if not routes or any(not item for item in routes):
        raise EvaluationError("--routes must be a CSV list of non-empty names")
    return routes


def validate_selection(
    raw: Any, dataset: dict[str, Any], routes: list[str]
) -> dict[str, list[str]]:
    if not isinstance(raw, dict) or raw.get("version") != 1:
        raise EvaluationError("selection must be an object with version=1")
    raw_cases = raw.get("cases")
    if not isinstance(raw_cases, dict) or not raw_cases:
        raise EvaluationError("selection.cases must be a non-empty object")
    known_cases = {case["id"] for case in dataset["cases"]}
    unknown_cases = sorted(set(raw_cases) - known_cases)
    if unknown_cases:
        raise EvaluationError(
            f"selection contains unknown cases: {', '.join(unknown_cases)}"
        )
    normalized: dict[str, list[str]] = {}
    for case_id, selected_routes in raw_cases.items():
        if (
            not isinstance(selected_routes, list)
            or not selected_routes
            or not all(isinstance(route, str) and route for route in selected_routes)
        ):
            raise EvaluationError(
                f"selection.cases.{case_id} must be a non-empty list of routes"
            )
        if len(set(selected_routes)) != len(selected_routes):
            raise EvaluationError(f"selection.cases.{case_id} contains duplicate routes")
        unknown_routes = sorted(set(selected_routes) - set(routes))
        if unknown_routes:
            raise EvaluationError(
                f"selection.cases.{case_id} contains unavailable routes: "
                f"{', '.join(unknown_routes)}"
            )
        normalized[case_id] = [route for route in routes if route in selected_routes]
    return normalized


def load_selection(
    path: Path, dataset: dict[str, Any], routes: list[str]
) -> dict[str, list[str]]:
    try:
        with path.open(encoding="utf-8") as stream:
            raw = json.load(stream)
    except OSError as error:
        raise EvaluationError(f"could not read selection: {error}") from error
    except json.JSONDecodeError as error:
        raise EvaluationError(f"invalid selection JSON: {error}") from error
    return validate_selection(raw, dataset, routes)
