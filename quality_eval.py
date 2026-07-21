#!/usr/bin/env python3
"""Benchmark determinístico de qualidade para as rotas do llm-router."""

from __future__ import annotations

import argparse
import ast
import concurrent.futures
import copy
import fnmatch
import hashlib
import json
import math
import os
import random
import re
import shutil
import stat
import statistics
import subprocess
import sys
import tempfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from benchmark_executor import (
    BenchmarkExecutor,
    ConfigError,
    ProcessResult,
    load_config,
    parse_json_object,
)


DATASET_VERSION = 2
SUPPORTED_DATASET_VERSIONS = {1, 2}
DIFFICULTIES = {"simple", "intermediate", "hard"}
EVALUATION_MODES = {"objective", "human", "hybrid"}
SANDBOX_PYTHON = Path(
    "/Applications/Xcode.app/Contents/Developer/usr/bin/python3"
)
MAX_CAPTURE_CHARS = 20_000
MAX_SNAPSHOT_FILE_BYTES = 16 * 1024 * 1024
MAX_SNAPSHOT_TOTAL_BYTES = 64 * 1024 * 1024
SNAPSHOT_CHUNK_BYTES = 1024 * 1024
UNSAFE_SNAPSHOT_PREFIX = "!unsafe:"
TEMP_PREFIX = "llm-router-quality-"
SANDBOXED_COMMAND_PREFIX = [
    "uv",
    "run",
    "--no-project",
    "--no-python-downloads",
    "python",
]
ASSERTION_TYPES = {
    "file_regex_count",
    "output_character_count_range",
    "output_all_patterns",
    "output_each_regex",
    "output_hashtag_count_max",
    "output_json_all_match",
    "output_json_all_lengths",
    "output_json_all_non_empty",
    "output_json_all_non_empty_values",
    "output_json_all_patterns",
    "output_json_ends_with_path",
    "output_json_equals",
    "output_json_length",
    "output_json_length_range",
    "output_json_last_item_regex",
    "output_json_number_range",
    "output_json_non_empty",
    "output_json_one_of",
    "output_json_sum_max",
    "output_json_values_in",
    "output_strict_json_object",
    "output_regex",
    "output_regex_count",
    "output_not_regex",
    "output_unique_values",
    "output_word_count_range",
    "python_behavior",
    "python_test_mutants",
    "file_regex",
    "file_not_regex",
    "command",
}

PYTHON_BEHAVIOR_RUNNER = r"""
import contextlib
import importlib.util
import io
import json
import os
import sys

request = json.loads(sys.stdin.read())
sys.stdin = io.StringIO("")
sys.path.insert(0, os.path.realpath(os.getcwd()))
capture = io.StringIO()
try:
    with contextlib.redirect_stdout(capture), contextlib.redirect_stderr(capture):
        module_path = os.path.join(*request["module"].split(".")) + ".py"
        spec = importlib.util.spec_from_file_location(request["module"], module_path)
        if spec is None or spec.loader is None:
            raise ImportError("module spec unavailable")
        module = importlib.util.module_from_spec(spec)
        sys.modules[request["module"]] = module
        spec.loader.exec_module(module)
        target = module
        for segment in request["call"].split("."):
            target = getattr(target, segment)
        if not callable(target):
            raise TypeError("target is not callable")
        value = target(*request["args"], **request["kwargs"])
    response = {"status": "returned", "type": type(value).__name__}
    try:
        json.dumps(value, ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError):
        response["value"] = None
        response["value_serializable"] = False
    else:
        response["value"] = value
except BaseException as error:
    response = {"status": "exception", "exception": type(error).__name__}
sys.stdout.write(json.dumps(response, ensure_ascii=False, allow_nan=False) + "\n")
"""

PYTHON_MUTANT_RUNNER = r"""
import builtins
import contextlib
import io
import json
import sys
import types
import unittest

def consume_sources():
    raw = sys.stdin.read()
    sys.stdin = io.StringIO("")
    payload = json.loads(raw)
    raw = None
    module_name = payload.pop("module")
    module_source = payload.pop("module_source")
    test_source = payload.pop("test_source")
    module_code = compile(module_source, "<candidate-module>", "exec")
    test_code = compile(test_source, "<candidate-test>", "exec")
    module_source = None
    test_source = None
    payload.clear()
    return module_name, module_code, test_code

module_name, module_code, test_code = consume_sources()
del consume_sources
real_import = builtins.__import__
allowed_import_roots = {
    "collections",
    "decimal",
    "fractions",
    "functools",
    "itertools",
    "math",
    "queue",
    "threading",
    "time",
    "types",
    "unittest",
}

def guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
    if level != 0:
        raise ImportError("relative imports are disabled")
    root = name.split(".", 1)[0]
    if name == module_name:
        return sys.modules[module_name]
    if root not in allowed_import_roots:
        raise ImportError("import is not allowed")
    return real_import(name, globals, locals, fromlist, level)

safe_builtins = dict(vars(builtins))
for blocked_name in (
    "breakpoint",
    "compile",
    "delattr",
    "dir",
    "eval",
    "exec",
    "getattr",
    "globals",
    "help",
    "input",
    "locals",
    "open",
    "setattr",
    "vars",
):
    safe_builtins.pop(blocked_name, None)
safe_builtins["__import__"] = guarded_import

capture = io.StringIO()
try:
    with contextlib.redirect_stdout(capture), contextlib.redirect_stderr(capture):
        candidate_module = types.ModuleType(module_name)
        candidate_module.__dict__.update(
            {
                "__name__": module_name,
                "__package__": "",
                "__builtins__": safe_builtins,
            }
        )
        sys.modules[module_name] = candidate_module
        exec(module_code, candidate_module.__dict__)
        candidate_tests = types.ModuleType("quality_candidate_tests")
        candidate_tests.__dict__.update(
            {
                "__name__": "quality_candidate_tests",
                "__package__": "",
                "__builtins__": safe_builtins,
            }
        )
        exec(test_code, candidate_tests.__dict__)
        suite = unittest.defaultTestLoader.loadTestsFromModule(candidate_tests)
        result = unittest.TextTestRunner(stream=capture, verbosity=0).run(suite)
    response = {"status": "completed", "successful": result.wasSuccessful()}
except BaseException as error:
    response = {"status": "harness_error", "exception": type(error).__name__}
sys.stdout.write(json.dumps(response, sort_keys=True) + "\n")
"""


class EvaluationError(RuntimeError):
    """Raised when the benchmark input or execution is invalid."""


ExecuteFunction = Callable[[str, str, str, Path], ProcessResult]


def _truncate_capture(value: str | bytes, limit: int = MAX_CAPTURE_CHARS) -> str:
    if isinstance(value, bytes):
        value = value.decode("utf-8", errors="replace")
    if len(value) <= limit:
        return value
    return value[:limit] + "\n[conteúdo truncado pelo benchmark]"


def _non_empty_string(value: Any, path: str) -> str:
    if not isinstance(value, str) or not value:
        raise EvaluationError(f"{path} precisa ser uma string não vazia")
    return value


def _positive_int(value: Any, path: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise EvaluationError(f"{path} precisa ser um inteiro positivo")
    return value


def _positive_or_zero_int(value: Any, path: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise EvaluationError(f"{path} precisa ser um inteiro maior ou igual a zero")
    return value


def _finite_number(value: Any, path: str) -> float:
    if (
        not isinstance(value, (int, float))
        or isinstance(value, bool)
        or not math.isfinite(float(value))
    ):
        raise EvaluationError(f"{path} precisa ser um número finito")
    return float(value)


def _safe_relative_path(value: Any, path: str) -> str:
    raw = _non_empty_string(value, path)
    candidate = Path(raw)
    if candidate == Path(".") or candidate.is_absolute() or ".." in candidate.parts:
        raise EvaluationError(f"{path} precisa apontar para um caminho relativo seguro")
    return raw


def _assertion_type(assertion: dict[str, Any], path: str) -> str:
    if assertion.get("type") == "python_hidden_tests" or "python_hidden_tests" in assertion:
        raise EvaluationError(
            f"{path}.type python_hidden_tests foi removido; use python_behavior"
        )
    explicit = assertion.get("type")
    compact = [name for name in ASSERTION_TYPES if name in assertion]
    if explicit is not None:
        kind = _non_empty_string(explicit, f"{path}.type")
        if compact and any(name != kind for name in compact):
            raise EvaluationError(f"{path} mistura tipos de assertion")
    elif len(compact) == 1:
        kind = compact[0]
    else:
        raise EvaluationError(f"{path} precisa declarar exatamente um tipo de assertion")
    if kind not in ASSERTION_TYPES:
        raise EvaluationError(f"{path}.type desconhecido: {kind}")
    return kind


def _normalized_sandboxed_command_argv(value: Any, path: str) -> list[str]:
    if (
        not isinstance(value, list)
        or not value
        or not all(isinstance(item, str) for item in value)
    ):
        raise EvaluationError(f"{path} precisa ser uma lista não vazia de strings")
    argv = list(value)
    if argv[: len(SANDBOXED_COMMAND_PREFIX)] != SANDBOXED_COMMAND_PREFIX:
        raise EvaluationError(
            f"{path} está desabilitado fora do prefixo seguro "
            "uv run --no-project --no-python-downloads python"
        )
    payload = argv[len(SANDBOXED_COMMAND_PREFIX) :]
    if len(payload) == 1:
        script = _safe_relative_path(payload[0], f"{path}[5]")
        if Path(script).suffix != ".py":
            raise EvaluationError(f"{path} aceita somente um script Python relativo ou -c")
    elif len(payload) == 2 and payload[0] == "-c":
        _non_empty_string(payload[1], f"{path}[6]")
    else:
        raise EvaluationError(
            f"{path} aceita somente um script Python relativo ou -c após o prefixo seguro"
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
            f"{path} precisa conter somente identificadores Python sem acesso dunder"
        )
    return raw


def _json_serializable_value(value: Any, path: str) -> Any:
    try:
        json.dumps(value, ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError) as error:
        raise EvaluationError(f"{path} precisa ser serializável como JSON") from error
    return value


def _normalized_assertion(assertion: Any, path: str) -> dict[str, Any]:
    if not isinstance(assertion, dict):
        raise EvaluationError(f"{path} precisa ser um objeto")
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
            raise EvaluationError(f"{path}.{kind} precisa ser um objeto")
        elif kind == "command":
            result.setdefault("argv", compact_payload)
        elif kind not in {"output_json_equals", "output_json_one_of"}:
            raise EvaluationError(f"{path}.{kind} precisa ser um objeto")
    result["type"] = kind

    weight = result.get("weight", 1)
    if (
        not isinstance(weight, (int, float))
        or isinstance(weight, bool)
        or not math.isfinite(float(weight))
        or weight <= 0
    ):
        raise EvaluationError(f"{path}.weight precisa ser um número positivo e finito")
    result["weight"] = float(weight)
    critical = result.get("critical", False)
    if not isinstance(critical, bool):
        raise EvaluationError(f"{path}.critical precisa ser booleano")
    result["critical"] = critical
    if "turn" in result:
        turn = result["turn"]
        if not isinstance(turn, int) or isinstance(turn, bool) or turn not in {1, 2}:
            raise EvaluationError(f"{path}.turn precisa ser 1 ou 2")

    if kind in {"output_json_equals", "output_json_one_of"}:
        result["path"] = _non_empty_string(result.get("path"), f"{path}.path")
        if "expected" not in result:
            raise EvaluationError(f"{path}.expected é obrigatório")
        if kind == "output_json_one_of" and (
            not isinstance(result["expected"], list) or not result["expected"]
        ):
            raise EvaluationError(f"{path}.expected precisa ser uma lista não vazia")
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
            raise EvaluationError(f"{path}.minimum precisa ser menor ou igual a maximum")
    elif kind in {"output_regex_count"}:
        result["pattern"] = _non_empty_string(result.get("pattern"), f"{path}.pattern")
        result["minimum"] = _positive_or_zero_int(result.get("minimum"), f"{path}.minimum")
        result["maximum"] = _positive_or_zero_int(result.get("maximum"), f"{path}.maximum")
        if result["minimum"] > result["maximum"]:
            raise EvaluationError(f"{path}.minimum precisa ser menor ou igual a maximum")
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
            raise EvaluationError(f"{path}.minimum precisa ser menor ou igual a maximum")
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
            raise EvaluationError(f"{path}.allowed precisa ser uma lista não vazia")
        result["allowed"] = allowed
    elif kind == "output_json_all_match":
        result["path"] = _non_empty_string(result.get("path"), f"{path}.path")
        required_keys = result.get("required_keys")
        if (
            not isinstance(required_keys, list)
            or not required_keys
            or not all(isinstance(item, str) and item for item in required_keys)
        ):
            raise EvaluationError(f"{path}.required_keys precisa ser uma lista de strings")
        result["required_keys"] = required_keys
    elif kind == "output_json_all_non_empty":
        result["path"] = _non_empty_string(result.get("path"), f"{path}.path")
        required_keys = result.get("required_keys")
        if (
            not isinstance(required_keys, list)
            or not required_keys
            or not all(isinstance(item, str) and item for item in required_keys)
        ):
            raise EvaluationError(f"{path}.required_keys precisa ser uma lista de strings")
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
            raise EvaluationError(f"{path}.patterns precisa ser uma lista de strings")
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
            raise EvaluationError(f"{path}.require_non_empty precisa ser booleano")
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
            raise EvaluationError(f"{path}.paths precisa ser uma lista de strings")
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
            raise EvaluationError(f"{path}.probes precisa ser uma lista não vazia")
        probes: list[dict[str, Any]] = []
        probe_ids: set[str] = set()
        for probe_index, raw_probe in enumerate(raw_probes):
            probe_path = f"{path}.probes[{probe_index}]"
            if not isinstance(raw_probe, dict):
                raise EvaluationError(f"{probe_path} precisa ser um objeto")
            probe_id = _non_empty_string(raw_probe.get("id"), f"{probe_path}.id")
            if probe_id in probe_ids:
                raise EvaluationError(f"{path}.probes possui id duplicado: {probe_id}")
            probe_ids.add(probe_id)
            args = raw_probe.get("args", [])
            kwargs = raw_probe.get("kwargs", {})
            if not isinstance(args, list):
                raise EvaluationError(f"{probe_path}.args precisa ser uma lista")
            if not isinstance(kwargs, dict) or not all(
                isinstance(key, str) for key in kwargs
            ):
                raise EvaluationError(
                    f"{probe_path}.kwargs precisa ser um objeto com chaves string"
                )
            has_return = "expected_return" in raw_probe
            has_type = "expected_type" in raw_probe
            has_exception = "expected_exception" in raw_probe
            if has_exception and (has_return or has_type):
                raise EvaluationError(
                    f"{probe_path} não pode combinar expected_exception com retorno ou tipo"
                )
            if not has_exception and not (has_return or has_type):
                raise EvaluationError(
                    f"{probe_path} precisa declarar expected_return, expected_type ou expected_exception"
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
            raise EvaluationError(f"{path}.timeout_seconds precisa estar entre 0 e 30")
    elif kind == "python_test_mutants":
        result["test_file"] = _safe_relative_path(
            result.get("test_file"), f"{path}.test_file"
        )
        result["module_file"] = _safe_relative_path(
            result.get("module_file"), f"{path}.module_file"
        )
        raw_mutants = result.get("mutants")
        if not isinstance(raw_mutants, list) or not raw_mutants:
            raise EvaluationError(f"{path}.mutants precisa ser uma lista não vazia")
        mutants: list[dict[str, str]] = []
        mutant_ids: set[str] = set()
        for mutant_index, raw_mutant in enumerate(raw_mutants):
            mutant_path = f"{path}.mutants[{mutant_index}]"
            if not isinstance(raw_mutant, dict):
                raise EvaluationError(f"{mutant_path} precisa ser um objeto")
            mutant_id = _non_empty_string(raw_mutant.get("id"), f"{mutant_path}.id")
            if mutant_id in mutant_ids:
                raise EvaluationError(f"{path} possui mutant id duplicado: {mutant_id}")
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
            raise EvaluationError(f"{path}.timeout_seconds precisa estar entre 0 e 30")
    elif kind == "command":
        result["argv"] = _normalized_sandboxed_command_argv(
            result.get("argv"), f"{path}.argv"
        )
        expected_exit = result.get("expected_exit", 0)
        if not isinstance(expected_exit, int) or isinstance(expected_exit, bool):
            raise EvaluationError(f"{path}.expected_exit precisa ser um inteiro")
        timeout = result.get("timeout_seconds", 30)
        timeout = _finite_number(timeout, f"{path}.timeout_seconds")
        if timeout <= 0 or timeout > 30:
            raise EvaluationError(f"{path}.timeout_seconds precisa estar entre 0 e 30")
        result["expected_exit"] = expected_exit
        result["timeout_seconds"] = timeout
    return result


def _normalized_human_evaluation(value: Any, path: str) -> dict[str, Any] | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise EvaluationError(f"{path} precisa ser um objeto")
    result: dict[str, Any] = {}
    for key in (
        "blind",
        "randomize_output_order",
        "pairwise_comparison",
        "retain_rationales",
    ):
        raw_flag = value.get(key)
        if not isinstance(raw_flag, bool):
            raise EvaluationError(f"{path}.{key} precisa ser booleano")
        result[key] = raw_flag
    raw_scale = value.get("dimension_scale")
    if not isinstance(raw_scale, dict):
        raise EvaluationError(f"{path}.dimension_scale precisa ser um objeto")
    minimum = _finite_number(
        raw_scale.get("minimum"), f"{path}.dimension_scale.minimum"
    )
    maximum = _finite_number(
        raw_scale.get("maximum"), f"{path}.dimension_scale.maximum"
    )
    if minimum >= maximum:
        raise EvaluationError(
            f"{path}.dimension_scale.minimum precisa ser menor que maximum"
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
        raise EvaluationError(f"{path} precisa ser um objeto ou uma lista")
    if not isinstance(raw_criteria, list) or not raw_criteria:
        raise EvaluationError(f"{path}.criteria precisa ser uma lista não vazia")
    criteria: list[dict[str, Any]] = []
    criterion_ids: set[str] = set()
    for index, raw_criterion in enumerate(raw_criteria):
        criterion_path = f"{path}.criteria[{index}]"
        if not isinstance(raw_criterion, dict):
            raise EvaluationError(f"{criterion_path} precisa ser um objeto")
        criterion_id = _non_empty_string(
            raw_criterion.get("id", raw_criterion.get("dimension")),
            f"{criterion_path}.id",
        )
        if criterion_id in criterion_ids:
            raise EvaluationError(f"{path} possui critério duplicado: {criterion_id}")
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
            raise EvaluationError(f"{criterion_path}.weight precisa ser positivo")
    weight_sum = sum(criterion["weight"] for criterion in criteria)
    if not math.isclose(weight_sum, 100.0, abs_tol=1e-6):
        raise EvaluationError(f"{path}.criteria precisa totalizar peso 100")

    if not isinstance(raw_scale, dict):
        raise EvaluationError(f"{path}.scale precisa ser um objeto")
    scale_min = _finite_number(raw_scale.get("min"), f"{path}.scale.min")
    scale_max = _finite_number(raw_scale.get("max"), f"{path}.scale.max")
    if scale_min >= scale_max:
        raise EvaluationError(f"{path}.scale.min precisa ser menor que scale.max")
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
        raise EvaluationError("dataset precisa ser um objeto JSON")
    dataset_version = raw.get("version")
    if dataset_version not in SUPPORTED_DATASET_VERSIONS:
        supported = ", ".join(str(version) for version in sorted(SUPPORTED_DATASET_VERSIONS))
        raise EvaluationError(f"dataset.version precisa ser um destes valores: {supported}")
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
        raise EvaluationError("dataset.cases precisa ser uma lista não vazia")

    case_ids: set[str] = set()
    cases: list[dict[str, Any]] = []
    for case_index, raw_case in enumerate(raw_cases):
        case_path = f"dataset.cases[{case_index}]"
        if not isinstance(raw_case, dict):
            raise EvaluationError(f"{case_path} precisa ser um objeto")
        case_id = _non_empty_string(raw_case.get("id"), f"{case_path}.id")
        if case_id in case_ids:
            raise EvaluationError(f"case id duplicado: {case_id}")
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
            if difficulty not in DIFFICULTIES:
                allowed = ", ".join(sorted(DIFFICULTIES))
                raise EvaluationError(
                    f"{case_path}.difficulty precisa ser um destes valores: {allowed}"
                )
            evaluation_mode = _non_empty_string(
                raw_case.get("evaluation_mode"), f"{case_path}.evaluation_mode"
            )
            if evaluation_mode not in EVALUATION_MODES:
                allowed = ", ".join(sorted(EVALUATION_MODES))
                raise EvaluationError(
                    f"{case_path}.evaluation_mode precisa ser um destes valores: {allowed}"
                )
            has_prompt = "prompt" in raw_case
            has_turns = "turns" in raw_case
            if has_prompt == has_turns:
                raise EvaluationError(
                    f"{case_path} precisa declarar exatamente um entre prompt e turns"
                )
            if has_prompt:
                turns = [_non_empty_string(raw_case.get("prompt"), f"{case_path}.prompt")]
            else:
                raw_turns = raw_case.get("turns")
                if not isinstance(raw_turns, list) or len(raw_turns) not in {1, 2}:
                    raise EvaluationError(f"{case_path}.turns precisa conter 1 ou 2 turnos")
                turns = []
                for turn_index, raw_turn in enumerate(raw_turns):
                    turn_path = f"{case_path}.turns[{turn_index}]"
                    if not isinstance(raw_turn, dict):
                        raise EvaluationError(f"{turn_path} precisa ser um objeto")
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
            raise EvaluationError(f"{case_path}.role precisa ser judge ou worker")
        raw_files = raw_case.get("files", {})
        if not isinstance(raw_files, dict):
            raise EvaluationError(f"{case_path}.files precisa ser um objeto")
        files: dict[str, str] = {}
        for file_path, content in raw_files.items():
            normalized_path = _safe_relative_path(file_path, f"{case_path}.files")
            if not isinstance(content, str):
                raise EvaluationError(f"{case_path}.files[{file_path}] precisa ser uma string")
            files[normalized_path] = content
        raw_allowed_files = raw_case.get("allowed_files", [])
        if not isinstance(raw_allowed_files, list) or not all(
            isinstance(item, str) for item in raw_allowed_files
        ):
            raise EvaluationError(f"{case_path}.allowed_files precisa ser uma lista de strings")
        allowed_files = [
            _safe_relative_path(item, f"{case_path}.allowed_files[{allowed_index}]")
            for allowed_index, item in enumerate(raw_allowed_files)
        ]
        raw_assertions = raw_case.get("assertions", [])
        assertions_required = dataset_version == 1 or evaluation_mode in {"objective", "hybrid"}
        if not isinstance(raw_assertions, list) or (assertions_required and not raw_assertions):
            requirement = "uma lista não vazia" if assertions_required else "uma lista"
            raise EvaluationError(f"{case_path}.assertions precisa ser {requirement}")
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
        raise EvaluationError(f"não foi possível ler dataset: {error}") from error
    except json.JSONDecodeError as error:
        raise EvaluationError(f"dataset JSON inválido: {error}") from error
    return validate_dataset(raw)


def validate_routes(
    config: dict[str, Any], requested: list[str] | None, required_roles: set[str] | None = None
) -> list[str]:
    raw_routes = config.get("routes")
    if not isinstance(raw_routes, list) or not raw_routes:
        raise EvaluationError("config.routes precisa ser uma lista não vazia")
    if requested is not None:
        if not requested:
            raise EvaluationError("--routes precisa conter ao menos uma rota")
        if len(set(requested)) != len(requested):
            raise EvaluationError("--routes contém rota duplicada")
    requested_names = set(requested or [])
    roles_to_validate = {"worker"} if required_roles is None else required_roles
    available: list[str] = []
    for index, route in enumerate(raw_routes):
        if not isinstance(route, dict):
            raise EvaluationError(f"config.routes[{index}] precisa ser um objeto")
        name = _non_empty_string(route.get("name"), f"config.routes[{index}].name")
        if name in available:
            raise EvaluationError(f"rota duplicada na config: {name}")
        headless = route.get("headless")
        if not isinstance(headless, dict):
            raise EvaluationError(f"rota {name} não possui routes[].headless")
        if requested is None or name in requested_names:
            for role in roles_to_validate:
                if not isinstance(headless.get(role), dict):
                    raise EvaluationError(
                        f"rota {name} não possui routes[].headless.{role}"
                    )
        available.append(name)
    if requested is None:
        return available
    selected: list[str] = []
    for name in requested:
        if name not in available:
            raise EvaluationError(f"rota desconhecida em --routes: {name}")
        selected.append(name)
    return selected


def parse_routes(value: str | None) -> list[str] | None:
    if value is None:
        return None
    routes = [item.strip() for item in value.split(",")]
    if not routes or any(not item for item in routes):
        raise EvaluationError("--routes precisa ser uma lista CSV de nomes não vazios")
    return routes


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


def _sandbox_profile(workspace: Path, allow_workspace_read: bool = True) -> str:
    workspace_root = workspace.resolve()
    readable_paths = [
        Path("/usr/bin"),
        Path("/usr/lib"),
        Path("/usr/share"),
        Path("/System/Library"),
        Path("/Library/Apple/System/Library"),
        Path("/Applications/Xcode.app/Contents/Developer/Library/Frameworks/Python3.framework"),
        Path("/private/var/db"),
        Path("/private/etc"),
        Path("/System/Volumes/Preboot"),
        Path("/Library/Preferences"),
        Path("/dev/null"),
        Path("/dev/urandom"),
    ]
    if allow_workspace_read:
        readable_paths.insert(0, workspace_root)
    rules = [
        "(version 1)",
        "(deny default)",
        "(allow process*)",
        "(allow signal (target self))",
        "(allow system*)",
        "(allow ipc-posix*)",
        "(allow sysctl-read)",
        "(allow mach-lookup)",
        "(allow file-read-metadata)",
        "(allow file-read*)",
    ]
    protected_roots = {
        Path("/Users"),
        Path("/Volumes"),
        Path("/private/tmp"),
        Path("/private/var/tmp"),
        Path(tempfile.gettempdir()).resolve(),
    }
    for root in sorted(protected_roots, key=lambda item: str(item)):
        if allow_workspace_read and workspace_root.is_relative_to(root):
            rules.append(
                "(deny file-read* (require-all "
                f"(subpath {json.dumps(str(root))}) "
                f"(require-not (subpath {json.dumps(str(workspace_root))}))))"
            )
        else:
            rules.append(f"(deny file-read* (subpath {json.dumps(str(root))}))")
    for path in readable_paths:
        rule = "literal" if path.is_file() else "subpath"
        rules.append(f"(allow file-read* ({rule} {json.dumps(str(path))}))")
    return "\n".join(rules)


def _run_sandboxed_python(
    workspace: Path,
    wrapper: str,
    timeout_seconds: float,
    *,
    stdin_source: str | None = None,
    wrapper_argv: list[str] | None = None,
    allow_workspace_read: bool = True,
) -> dict[str, Any]:
    sandbox = shutil.which("sandbox-exec")
    if sandbox != "/usr/bin/sandbox-exec":
        raise EvaluationError("/usr/bin/sandbox-exec é obrigatório para graders Python")
    python = SANDBOX_PYTHON
    if not python.is_file():
        raise EvaluationError(f"{python} é obrigatório para graders Python")
    try:
        completed = subprocess.run(
            [
                sandbox,
                "-p",
                _sandbox_profile(workspace, allow_workspace_read),
                str(python),
                "-I",
                "-B",
                "-c",
                wrapper,
                *(wrapper_argv or []),
            ],
            cwd=workspace,
            env={
                "PATH": "/usr/bin:/bin",
                "LANG": "C.UTF-8",
                "PYTHONHASHSEED": "0",
                "PYTHONDONTWRITEBYTECODE": "1",
            },
            text=True,
            input=stdin_source,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout_seconds,
            check=False,
        )
        return {
            "status": "completed",
            "exit_code": completed.returncode,
            "stdout_sha256": hashlib.sha256(completed.stdout.encode("utf-8")).hexdigest(),
            "stderr_sha256": hashlib.sha256(completed.stderr.encode("utf-8")).hexdigest(),
            "_stdout": completed.stdout,
            "_stderr": completed.stderr,
        }
    except subprocess.TimeoutExpired:
        return {"status": "timeout", "exit_code": None}


def _evaluate_sandboxed_command(assertion: dict[str, Any], cwd: Path) -> dict[str, Any]:
    payload = assertion["argv"][len(SANDBOXED_COMMAND_PREFIX) :]
    if len(payload) == 1:
        script = _safe_grader_file(cwd, payload[0])
        wrapper = (
            "import runpy,sys;"
            "sys.path.insert(0,'.');"
            "runpy.run_path(sys.argv[1],run_name='__main__')"
        )
        grader = _run_sandboxed_python(
            cwd,
            wrapper,
            assertion["timeout_seconds"],
            wrapper_argv=[script.relative_to(cwd).as_posix()],
        )
    else:
        wrapper = (
            "import io,sys;"
            "source=sys.stdin.read();"
            "sys.stdin=io.StringIO('');"
            "code=compile(source,'<quality-command>','exec');"
            "source=None;"
            "sys.path.insert(0,'.');"
            "exec(code,{'__name__':'__main__'})"
        )
        grader = _run_sandboxed_python(
            cwd,
            wrapper,
            assertion["timeout_seconds"],
            stdin_source=payload[1],
        )
    return {
        "passed": grader["status"] == "completed"
        and grader["exit_code"] == assertion["expected_exit"],
        "grader_status": grader["status"],
        "expected_exit": assertion["expected_exit"],
        "actual_exit": grader["exit_code"],
        "grader_stdout_sha256": grader.get("stdout_sha256"),
        "grader_stderr_sha256": grader.get("stderr_sha256"),
    }


def _read_regular_text(workspace: Path, relative_path: str) -> str:
    normalized = _safe_relative_path(relative_path, "arquivo para leitura")
    parts = Path(normalized).parts
    directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    directory_flags |= getattr(os, "O_NOFOLLOW", 0)
    file_flags = os.O_RDONLY | getattr(os, "O_NONBLOCK", 0)
    file_flags |= getattr(os, "O_NOFOLLOW", 0)
    descriptors: list[int] = []
    try:
        current_descriptor = os.open(workspace, directory_flags)
        descriptors.append(current_descriptor)
        for segment in parts[:-1]:
            current_descriptor = os.open(
                segment, directory_flags, dir_fd=current_descriptor
            )
            descriptors.append(current_descriptor)
            if not stat.S_ISDIR(os.fstat(current_descriptor).st_mode):
                raise EvaluationError(
                    f"diretório inseguro no caminho do arquivo: {normalized}"
                )
        file_descriptor = os.open(
            parts[-1], file_flags, dir_fd=current_descriptor
        )
        descriptors.append(file_descriptor)
        metadata = os.fstat(file_descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise EvaluationError(f"arquivo inseguro para leitura: {normalized}")
        if metadata.st_size > MAX_SNAPSHOT_FILE_BYTES:
            raise EvaluationError(
                f"arquivo excede o limite de {MAX_SNAPSHOT_FILE_BYTES} bytes: {normalized}"
            )
        chunks: list[bytes] = []
        observed_bytes = 0
        while True:
            chunk = os.read(file_descriptor, SNAPSHOT_CHUNK_BYTES)
            if not chunk:
                break
            observed_bytes += len(chunk)
            if observed_bytes > MAX_SNAPSHOT_FILE_BYTES:
                raise EvaluationError(
                    f"arquivo cresceu além do limite de {MAX_SNAPSHOT_FILE_BYTES} bytes: "
                    f"{normalized}"
                )
            chunks.append(chunk)
        return b"".join(chunks).decode("utf-8")
    except OSError as error:
        raise EvaluationError(
            f"arquivo inseguro ou indisponível para leitura: {normalized}: "
            f"{type(error).__name__}"
        ) from error
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def _safe_grader_file(workspace: Path, relative_path: str) -> Path:
    target = workspace / relative_path
    workspace_root = workspace.resolve()
    try:
        resolved = target.resolve(strict=True)
    except OSError as error:
        raise EvaluationError(f"arquivo do grader ausente: {relative_path}: {error}") from error
    if not resolved.is_relative_to(workspace_root) or target.is_symlink() or not target.is_file():
        raise EvaluationError(f"arquivo inseguro para grader: {relative_path}")
    return target


def _sandbox_json_response(grader: dict[str, Any]) -> dict[str, Any] | None:
    if grader.get("status") != "completed" or grader.get("exit_code") != 0:
        return None
    lines = [line for line in grader.get("_stdout", "").splitlines() if line.strip()]
    if len(lines) != 1:
        return None
    try:
        parsed = json.loads(lines[0])
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _safe_behavior_module(workspace: Path, module: str) -> None:
    forbidden_roots = {"contextlib", "importlib", "io", "json", "os", "sys"}
    if module.split(".", 1)[0] in forbidden_roots:
        raise EvaluationError(f"python_behavior.module reservado: {module}")
    relative_path = Path(*module.split(".")).with_suffix(".py").as_posix()
    _safe_grader_file(workspace, relative_path)


def _behavior_probe_passed(probe: dict[str, Any], response: dict[str, Any] | None) -> bool:
    if response is None:
        return False
    if "expected_exception" in probe:
        return (
            response.get("status") == "exception"
            and response.get("exception") == probe["expected_exception"]
        )
    if response.get("status") != "returned":
        return False
    if "expected_return" in probe and response.get("value") != probe["expected_return"]:
        return False
    if "expected_type" in probe and response.get("type") != probe["expected_type"]:
        return False
    return True


def _evaluate_python_behavior(
    assertion: dict[str, Any], cwd: Path
) -> dict[str, Any]:
    probe_results: list[dict[str, Any]] = []
    for probe in assertion["probes"]:
        _safe_behavior_module(cwd, probe["module"])
        request = {
            "module": probe["module"],
            "call": probe["call"],
            "args": probe["args"],
            "kwargs": probe["kwargs"],
        }
        request_json = json.dumps(
            request, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        )
        grader = _run_sandboxed_python(
            cwd,
            PYTHON_BEHAVIOR_RUNNER,
            assertion["timeout_seconds"],
            stdin_source=request_json,
        )
        response = _sandbox_json_response(grader)
        response_hash = grader.get("stdout_sha256") or _sha256_json(
            {"status": grader.get("status"), "exit_code": grader.get("exit_code")}
        )
        probe_results.append(
            {
                "id": probe["id"],
                "passed": _behavior_probe_passed(probe, response),
                "request_sha256": hashlib.sha256(request_json.encode("utf-8")).hexdigest(),
                "response_sha256": response_hash,
            }
        )
    return {
        "passed": bool(probe_results) and all(item["passed"] for item in probe_results),
        "probes": probe_results,
    }


def _validate_mutant_test_ast(source: str) -> None:
    try:
        tree = ast.parse(source, filename="<candidate-test>")
    except SyntaxError as error:
        raise EvaluationError(f"python_test_mutants recebeu teste inválido: {error.msg}") from error
    forbidden_modules = {"inspect", "linecache", "os", "pathlib", "subprocess"}
    forbidden_names = {
        "__base__",
        "__bases__",
        "__builtins__",
        "__class__",
        "__closure__",
        "__code__",
        "__dict__",
        "__file__",
        "__getattribute__",
        "__import__",
        "__mro__",
        "__subclasses__",
        "_getframe",
        "co_cellvars",
        "co_code",
        "co_consts",
        "co_filename",
        "co_freevars",
        "co_names",
        "compile",
        "eval",
        "exec",
        "f_back",
        "f_code",
        "f_globals",
        "f_locals",
        "findsource",
        "getsource",
        "getsourcelines",
        "open",
        "read_bytes",
        "read_text",
    }
    violations: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                root = alias.name.split(".", 1)[0]
                if root in forbidden_modules:
                    violations.add(root)
        elif isinstance(node, ast.ImportFrom):
            root = (node.module or "").split(".", 1)[0]
            if root in forbidden_modules:
                violations.add(root)
            for alias in node.names:
                if alias.name in forbidden_names:
                    violations.add(alias.name)
        elif isinstance(node, ast.Name) and node.id in forbidden_names:
            violations.add(node.id)
        elif isinstance(node, ast.Attribute) and node.attr in forbidden_names:
            violations.add(node.attr)
        elif isinstance(node, ast.Constant) and node.value in forbidden_names:
            violations.add(str(node.value))
    if violations:
        names = ", ".join(sorted(violations))
        raise EvaluationError(
            f"python_test_mutants rejeitado pelo AST guard por acesso ao source: {names}"
        )


def _evaluate_python_test_mutants(
    assertion: dict[str, Any], cwd: Path
) -> dict[str, Any]:
    grader_summaries: list[dict[str, Any]] = []
    test_source = _read_regular_text(cwd, assertion["test_file"])
    reference_source = _read_regular_text(cwd, assertion["module_file"])
    _validate_mutant_test_ast(test_source)
    _validate_mutant_test_ast(reference_source)
    for mutant in assertion["mutants"]:
        _validate_mutant_test_ast(mutant["content"])
    module_path = Path(assertion["module_file"])
    if len(module_path.parts) != 1 or module_path.suffix != ".py":
        raise EvaluationError(
            "python_test_mutants.module_file precisa ser um módulo Python de nível raiz"
        )
    module_name = _safe_python_symbol_path(module_path.stem, "module_file")

    def run_variant(mutant: dict[str, str] | None) -> dict[str, Any]:
        module_source = reference_source if mutant is None else mutant["content"]
        payload = json.dumps(
            {
                "module": module_name,
                "module_source": module_source,
                "test_source": test_source,
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        grader = _run_sandboxed_python(
            Path(tempfile.gettempdir()).resolve(),
            PYTHON_MUTANT_RUNNER,
            assertion["timeout_seconds"],
            stdin_source=payload,
            allow_workspace_read=False,
        )
        response = _sandbox_json_response(grader)
        if grader.get("status") == "timeout":
            status = "timeout"
            exit_code = None
        elif response is not None and response.get("status") == "completed":
            status = "completed"
            exit_code = 0 if response.get("successful") is True else 1
        else:
            status = "harness_error"
            exit_code = 1
        return {
            "status": status,
            "exit_code": exit_code,
            "request_sha256": hashlib.sha256(payload.encode("utf-8")).hexdigest(),
            "response_sha256": grader.get("stdout_sha256"),
        }

    reference = run_variant(None)
    if reference["status"] == "completed" and reference["exit_code"] == 0:
        for mutant in assertion["mutants"]:
            grader = run_variant(mutant)
            killed = (
                grader["status"] == "timeout"
                or (grader["status"] == "completed" and grader["exit_code"] != 0)
            )
            grader_summaries.append(
                {
                    "id": mutant["id"],
                    "killed": killed,
                    "status": grader["status"],
                    "exit_code": grader["exit_code"],
                    "request_sha256": grader["request_sha256"],
                    "response_sha256": grader["response_sha256"],
                }
            )
    return {
        "passed": (
            reference["status"] == "completed"
            and reference["exit_code"] == 0
            and len(grader_summaries) == len(assertion["mutants"])
            and all(item["killed"] for item in grader_summaries)
        ),
        "reference_status": reference["status"],
        "reference_exit_code": reference["exit_code"],
        "reference_request_sha256": reference["request_sha256"],
        "reference_response_sha256": reference["response_sha256"],
        "mutants": grader_summaries,
    }


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
            content = _read_regular_text(cwd, assertion["file"])
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
            content = _read_regular_text(cwd, assertion["file"])
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
            result.update(_evaluate_python_behavior(assertion, cwd))
        elif kind == "python_test_mutants":
            result.update(_evaluate_python_test_mutants(assertion, cwd))
        elif kind == "command":
            result.update(_evaluate_sandboxed_command(assertion, cwd))
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


def trash_directory(path: Path) -> str | None:
    temp_root = Path(tempfile.gettempdir()).resolve()
    try:
        resolved = path.resolve(strict=True)
    except OSError as error:
        return f"diretório temporário inválido: {error}"
    if (
        not path.is_absolute()
        or not resolved.is_relative_to(temp_root)
        or not resolved.name.startswith(TEMP_PREFIX)
    ):
        return f"trash recusado para caminho fora dos fixtures do benchmark: {path}"
    trash = shutil.which("trash")
    if not trash:
        return f"trash não encontrado; diretório temporário preservado em {path}"
    try:
        completed = subprocess.run(
            [trash, str(resolved)],
            text=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            check=False,
        )
    except OSError as error:
        return f"trash falhou para {resolved}: {error}"
    if completed.returncode != 0:
        detail = completed.stderr.strip() or f"exit code {completed.returncode}"
        return f"trash falhou para {resolved}: {detail}"
    return None


def _write_fixture(cwd: Path, files: dict[str, str]) -> None:
    for relative_path, content in files.items():
        target = cwd / relative_path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")


def _snapshot_files(cwd: Path) -> dict[str, str]:
    snapshot: dict[str, str] = {}
    total_bytes = 0
    for target in sorted(cwd.rglob("*")):
        relative = target.relative_to(cwd).as_posix()
        try:
            metadata = target.lstat()
        except OSError as error:
            snapshot[relative] = f"{UNSAFE_SNAPSHOT_PREFIX}lstat:{type(error).__name__}"
            continue
        if stat.S_ISDIR(metadata.st_mode):
            continue
        if stat.S_ISLNK(metadata.st_mode):
            try:
                link_target = os.readlink(target).encode("utf-8")
            except OSError as error:
                snapshot[relative] = (
                    f"{UNSAFE_SNAPSHOT_PREFIX}readlink:{type(error).__name__}"
                )
                continue
            snapshot[relative] = (
                "symlink:" + hashlib.sha256(link_target).hexdigest()
            )
            continue
        elif stat.S_ISREG(metadata.st_mode):
            if metadata.st_size > MAX_SNAPSHOT_FILE_BYTES:
                snapshot[relative] = (
                    f"{UNSAFE_SNAPSHOT_PREFIX}file_size:{metadata.st_size}"
                )
                continue
            if total_bytes + metadata.st_size > MAX_SNAPSHOT_TOTAL_BYTES:
                snapshot[relative] = (
                    f"{UNSAFE_SNAPSHOT_PREFIX}total_size:{metadata.st_size}"
                )
                continue
        else:
            file_type = stat.S_IFMT(metadata.st_mode)
            snapshot[relative] = f"{UNSAFE_SNAPSHOT_PREFIX}special:{file_type}"
            continue

        flags = os.O_RDONLY | getattr(os, "O_NONBLOCK", 0)
        flags |= getattr(os, "O_NOFOLLOW", 0)
        try:
            descriptor = os.open(target, flags)
        except OSError as error:
            snapshot[relative] = f"{UNSAFE_SNAPSHOT_PREFIX}open:{type(error).__name__}"
            continue
        try:
            opened_metadata = os.fstat(descriptor)
            if not stat.S_ISREG(opened_metadata.st_mode):
                snapshot[relative] = (
                    f"{UNSAFE_SNAPSHOT_PREFIX}type_changed:"
                    f"{stat.S_IFMT(opened_metadata.st_mode)}"
                )
                continue
            if opened_metadata.st_size > MAX_SNAPSHOT_FILE_BYTES:
                snapshot[relative] = (
                    f"{UNSAFE_SNAPSHOT_PREFIX}file_size:{opened_metadata.st_size}"
                )
                continue
            if total_bytes + opened_metadata.st_size > MAX_SNAPSHOT_TOTAL_BYTES:
                snapshot[relative] = (
                    f"{UNSAFE_SNAPSHOT_PREFIX}total_size:{opened_metadata.st_size}"
                )
                continue
            digest = hashlib.sha256()
            observed_bytes = 0
            while True:
                chunk = os.read(descriptor, SNAPSHOT_CHUNK_BYTES)
                if not chunk:
                    break
                observed_bytes += len(chunk)
                if observed_bytes > MAX_SNAPSHOT_FILE_BYTES:
                    snapshot[relative] = (
                        f"{UNSAFE_SNAPSHOT_PREFIX}file_grew:{observed_bytes}"
                    )
                    break
                digest.update(chunk)
            if relative in snapshot:
                continue
            if total_bytes + observed_bytes > MAX_SNAPSHOT_TOTAL_BYTES:
                snapshot[relative] = (
                    f"{UNSAFE_SNAPSHOT_PREFIX}total_size:"
                    f"{total_bytes + observed_bytes}"
                )
                continue
            total_bytes += observed_bytes
            snapshot[relative] = "regular:" + digest.hexdigest()
        except OSError as error:
            snapshot[relative] = f"{UNSAFE_SNAPSHOT_PREFIX}read:{type(error).__name__}"
        finally:
            os.close(descriptor)
    return snapshot


def _audit_files(
    before: dict[str, str], after: dict[str, str], allowed_patterns: list[str]
) -> dict[str, Any]:
    created = sorted(set(after) - set(before))
    deleted = sorted(set(before) - set(after))
    modified = sorted(
        path for path in set(before) & set(after) if before[path] != after[path]
    )
    changed = sorted({*created, *deleted, *modified})
    unexpected = [
        path
        for path in changed
        if not any(
            Path(path).match(pattern) or fnmatch.fnmatchcase(path, pattern)
            for pattern in allowed_patterns
        )
    ]
    unsafe_files = sorted(
        path
        for path, digest in after.items()
        if digest.startswith(UNSAFE_SNAPSHOT_PREFIX) or digest.startswith("symlink:")
    )
    unexpected = sorted({*unexpected, *unsafe_files})
    return {
        "type": "allowed_files",
        "weight": 0.0,
        "critical": True,
        "passed": not unexpected,
        "allowed_files": allowed_patterns,
        "created": created,
        "modified": modified,
        "deleted": deleted,
        "unexpected": unexpected,
        "unsafe_files": unsafe_files,
    }


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
                f"\n<user turn=\"{previous_index + 1}\">\n{turns[previous_index]}\n</user>",
                f"\n<assistant turn=\"{previous_index + 1}\">\n{outputs[previous_index]}\n</assistant>",
            ]
        )
    transcript.append(f"\n<user turn=\"{turn_index + 1}\">\n{turns[turn_index]}\n</user>")
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
    fixture = Path(tempfile.mkdtemp(prefix=TEMP_PREFIX))
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
            raise EvaluationError(f"caso {case['id']} não possui turnos executáveis")
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
                case["assertions"], f"status desconhecido do executor: {process.status}"
            )
            assertion_results.append(file_audit)
        elif file_audit["unsafe_files"]:
            status = "failed"
            unsafe_paths = ", ".join(file_audit["unsafe_files"])
            assertion_results = _failed_assertions(
                case["assertions"],
                f"workspace contém arquivo inseguro para leitura: {unsafe_paths}",
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
    finally:
        cleanup_error = trash_directory(fixture)

    if cleanup_error:
        status = "process_error"
        score = 0.0
        process_details["cleanup_error"] = cleanup_error
        assertion_results = _failed_assertions(case["assertions"], cleanup_error)

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


def prepare_execution_config(
    config: dict[str, Any],
    routes: list[str],
    roles: set[str],
    route_roles: dict[str, set[str]] | None = None,
) -> tuple[dict[str, Any], list[dict[str, str]]]:
    execution_config = copy.deepcopy(config)
    adjustments: list[dict[str, str]] = []
    for route in execution_config.get("routes", []):
        if route.get("name") not in routes:
            continue
        roles_for_route = route_roles.get(route["name"], set()) if route_roles else roles
        for role in sorted(roles_for_route):
            profile = route.get("headless", {}).get(role, {})
            argv = profile.get("argv")
            if not isinstance(argv, list) or not argv:
                continue
            executable = Path(argv[0]).name
            if executable == "codex":
                adjusted = list(argv)
                prompt_index = adjusted.index("-") if "-" in adjusted else len(adjusted)
                if "--skip-git-repo-check" not in adjusted:
                    adjusted.insert(prompt_index, "--skip-git-repo-check")
                    adjustments.append(
                        {
                            "route": route["name"],
                            "role": role,
                            "change": "Codex autorizado a executar no fixture temporário sem Git",
                        }
                    )
                    prompt_index += 1
                if "--ignore-user-config" not in adjusted:
                    adjusted.insert(prompt_index, "--ignore-user-config")
                    adjustments.append(
                        {
                            "route": route["name"],
                            "role": role,
                            "change": "Config global e MCPs do Codex ignorados no benchmark",
                        }
                    )
                profile["argv"] = adjusted
                continue
            if executable != "claude":
                continue
            adjusted: list[str] = []
            configured_tools: str | None = None
            index = 0
            while index < len(argv):
                item = argv[index]
                if item == "--dangerously-skip-permissions":
                    index += 1
                    continue
                if item in {"--permission-mode", "--tools"}:
                    if item == "--tools" and index + 1 < len(argv):
                        configured_tools = argv[index + 1]
                    index += 2
                    continue
                if item == "--mcp-config":
                    index += 1
                    while index < len(argv) and not argv[index].startswith("-"):
                        index += 1
                    continue
                if item in {"--strict-mcp-config", "--disable-slash-commands"}:
                    index += 1
                    continue
                adjusted.append(item)
                index += 1
            if role == "worker":
                if configured_tools and not any(
                    tool in configured_tools.split(",") for tool in {"Bash", "Edit", "Write"}
                ):
                    adjusted.extend(
                        ["--permission-mode", "dontAsk", "--tools", configured_tools]
                    )
                    change = f"Claude preservado no perfil read-only {configured_tools}"
                else:
                    adjusted.extend(
                        ["--permission-mode", "acceptEdits", "--tools", "Read,Edit,Write"]
                    )
                    change = "Claude limitado a Read,Edit,Write com permission-mode acceptEdits"
            else:
                adjusted.extend(["--tools", "Read"])
                change = "Claude limitado a Read para auditoria das fixtures"
            adjusted.extend(
                [
                    "--strict-mcp-config",
                    "--mcp-config",
                    '{"mcpServers":{}}',
                    "--disable-slash-commands",
                ]
            )
            adjustments.append(
                {
                    "route": route["name"],
                    "role": role,
                    "change": "MCPs externos desativados no fixture do benchmark",
                }
            )
            profile["argv"] = adjusted
            adjustments.append(
                {
                    "route": route["name"],
                    "role": role,
                    "change": change,
                }
            )
    return execution_config, adjustments


def _make_executor(config: dict[str, Any]) -> ExecuteFunction:
    def execute(route: str, role: str, prompt: str, cwd: Path) -> ProcessResult:
        logical_config_path = cwd / ".llm-router-quality-config.json"
        executor = BenchmarkExecutor(logical_config_path, config, cwd)
        return executor.execute_model(route, role, prompt)

    return execute


def _route_configs(config: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {route["name"]: route for route in config["routes"]}


def _required_environment(value: Any) -> set[str]:
    required: set[str] = set()
    if isinstance(value, str):
        required.update(re.findall(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}", value))
    elif isinstance(value, list):
        for item in value:
            required.update(_required_environment(item))
    elif isinstance(value, dict):
        source = value.get("from_env")
        if isinstance(source, str):
            required.add(source)
        for item in value.values():
            required.update(_required_environment(item))
    return required


def _safe_profile_argv(profile: dict[str, Any]) -> list[str] | None:
    raw_argv = profile.get("argv")
    if not isinstance(raw_argv, list) or not all(isinstance(item, str) for item in raw_argv):
        return None
    if any("${" in item for item in raw_argv):
        return None
    return [
        item.replace("{cwd}", "{fixture}").replace("{output_file}", "{temporary_output}")
        for item in raw_argv
    ]


def preflight(
    config: dict[str, Any],
    routes: list[str],
    roles: set[str],
    assertion_types: set[str] | None = None,
    route_roles: dict[str, set[str]] | None = None,
) -> dict[str, Any]:
    trash = shutil.which("trash")
    if not trash:
        raise EvaluationError("trash é obrigatório antes de executar o benchmark")
    if (assertion_types or set()) & {
        "command",
        "python_behavior",
        "python_test_mutants",
    }:
        if shutil.which("sandbox-exec") != "/usr/bin/sandbox-exec":
            raise EvaluationError(
                "/usr/bin/sandbox-exec é obrigatório para assertions Python seguras"
            )
        if not SANDBOX_PYTHON.is_file():
            raise EvaluationError(
                f"{SANDBOX_PYTHON} é obrigatório para assertions Python seguras"
            )
    route_configs = _route_configs(config)
    required_variables: set[str] = set()
    executables: dict[str, str] = {}
    safe_argv: dict[tuple[str, str], list[str] | None] = {}
    for route in routes:
        headless = route_configs[route]["headless"]
        required_variables.update(_required_environment(headless.get("env", {})))
        roles_for_route = route_roles.get(route, set()) if route_roles else roles
        for role in roles_for_route:
            profile = headless[role]
            raw_argv = profile.get("argv")
            if not isinstance(raw_argv, list) or not raw_argv:
                raise EvaluationError(f"{route}.{role}.argv precisa ser uma lista não vazia")
            required_variables.update(_required_environment(raw_argv))
            executable = raw_argv[0]
            if "${" in executable or "{" in executable:
                raise EvaluationError(f"executável dinâmico não suportado em {route}.{role}")
            resolved = shutil.which(executable)
            if not resolved:
                raise EvaluationError(f"executável ausente para {route}.{role}: {executable}")
            executables[executable] = resolved
            safe_argv[(route, role)] = _safe_profile_argv(profile)
    missing = sorted(name for name in required_variables if not os.environ.get(name))
    if missing:
        names = ", ".join(missing)
        raise EvaluationError(f"variáveis de ambiente obrigatórias ausentes: {names}")

    versions: dict[str, str] = {}
    for executable, resolved in executables.items():
        try:
            completed = subprocess.run(
                [resolved, "--version"],
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                timeout=5,
                check=False,
            )
            first_line = (completed.stdout or "").strip().splitlines()
            versions[executable] = first_line[0][:500] if first_line else "indisponível"
        except (OSError, subprocess.TimeoutExpired):
            versions[executable] = "indisponível"
    return {"safe_argv": safe_argv, "cli_versions": versions}


def _score_stats(items: list[dict[str, Any]]) -> dict[str, float]:
    scores = [float(item["score"]) for item in items]
    passed = sum(item["status"] == "passed" for item in items)
    return {
        "mean": round(statistics.fmean(scores), 6) if scores else 0.0,
        "median": round(statistics.median(scores), 6) if scores else 0.0,
        "worst": round(min(scores), 6) if scores else 0.0,
        "pass_rate": round(100.0 * passed / len(items), 6) if items else 0.0,
    }


def build_summary(results: list[dict[str, Any]]) -> dict[str, Any]:
    by_route: dict[str, list[dict[str, Any]]] = defaultdict(list)
    by_category: dict[str, list[dict[str, Any]]] = defaultdict(list)
    by_difficulty: dict[str, list[dict[str, Any]]] = defaultdict(list)
    by_route_category: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    by_route_category_difficulty: dict[
        tuple[str, str, str], list[dict[str, Any]]
    ] = defaultdict(list)
    for result in results:
        difficulty = result.get("difficulty", "legacy")
        by_route[result["route"]].append(result)
        by_category[result["category"]].append(result)
        by_difficulty[difficulty].append(result)
        by_route_category[(result["route"], result["category"])].append(result)
        by_route_category_difficulty[
            (result["route"], result["category"], difficulty)
        ].append(result)
    crossed: dict[str, dict[str, dict[str, float]]] = defaultdict(dict)
    for (route, category), items in sorted(by_route_category.items()):
        crossed[route][category] = _score_stats(items)
    crossed_difficulty: dict[
        str, dict[str, dict[str, dict[str, float]]]
    ] = defaultdict(lambda: defaultdict(dict))
    for (route, category, difficulty), items in sorted(
        by_route_category_difficulty.items()
    ):
        crossed_difficulty[route][category][difficulty] = _score_stats(items)
    return {
        "overall": _score_stats(results),
        "by_route": {name: _score_stats(items) for name, items in sorted(by_route.items())},
        "by_category": {
            name: _score_stats(items) for name, items in sorted(by_category.items())
        },
        "by_difficulty": {
            name: _score_stats(items) for name, items in sorted(by_difficulty.items())
        },
        "by_route_category": dict(crossed),
        "by_route_category_difficulty": {
            route: dict(categories) for route, categories in crossed_difficulty.items()
        },
        "status_counts": dict(sorted(Counter(result["status"] for result in results).items())),
    }


def load_report(path: Path) -> dict[str, Any]:
    try:
        with path.open(encoding="utf-8") as stream:
            report = json.load(stream)
    except OSError as error:
        raise EvaluationError(f"não foi possível ler relatório: {error}") from error
    except json.JSONDecodeError as error:
        raise EvaluationError(f"relatório JSON inválido: {error}") from error
    if not isinstance(report, dict) or not isinstance(report.get("results"), list):
        raise EvaluationError("relatório precisa conter results como lista")
    return report


def rescore_output_only_report(
    report: dict[str, Any], dataset: dict[str, Any], source_path: Path
) -> dict[str, Any]:
    rescored_report = copy.deepcopy(report)
    cases = {case["id"]: case for case in dataset["cases"]}
    rescored_count = 0
    retained_count = 0
    for result in rescored_report["results"]:
        case_id = result.get("case_id")
        case = cases.get(case_id)
        if case is None:
            raise EvaluationError(f"relatório contém caso ausente no dataset: {case_id}")
        output_only = (
            case["evaluation_mode"] in {"objective", "hybrid"}
            and case["role"] == "judge"
            and all(
                assertion["type"].startswith("output_")
                for assertion in case["assertions"]
            )
        )
        if not output_only or result.get("process_status") != "success":
            retained_count += 1
            continue

        original_evaluation = {
            "score": result.get("score"),
            "status": result.get("status"),
            "critical_failure": result.get("critical_failure"),
            "assertions": result.get("assertions", []),
        }
        score, assertion_results = evaluate_assertions(
            case["assertions"],
            result.get("output", ""),
            Path(tempfile.gettempdir()),
            [item.get("output", "") for item in result.get("turn_results", [])] or None,
        )
        retained_audits = [
            assertion
            for assertion in original_evaluation["assertions"]
            if assertion.get("type") in {"allowed_files", "canary_leak"}
        ]
        assertion_results.extend(retained_audits)
        critical_failed = any(
            assertion.get("critical", False) and not assertion.get("passed", False)
            for assertion in assertion_results
        )
        if critical_failed:
            score = 0.0
        result.update(
            {
                "original_evaluation": original_evaluation,
                "score": round(score, 6),
                "status": (
                    "passed"
                    if not critical_failed
                    and all(assertion.get("passed", False) for assertion in assertion_results)
                    else "failed"
                ),
                "critical_failure": critical_failed,
                "assertions": assertion_results,
            }
        )
        rescored_count += 1

    source_content = source_path.read_bytes()
    rescored_report["summary"] = build_summary(rescored_report["results"])
    rescored_report["audit"] = {
        "source_report": str(source_path),
        "source_report_sha256": hashlib.sha256(source_content).hexdigest(),
        "source_generated_at": report.get("generated_at"),
        "rescored_at": datetime.now(timezone.utc).isoformat(),
        "rescore_dataset_sha256": _sha256_json(dataset),
        "rescore_rubric_sha256": _rubric_sha256(dataset),
        "rescore_engine": _engine_identity(),
        "rescored_output_only_results": rescored_count,
        "retained_workspace_results": retained_count,
        "original_summary": report.get("summary"),
        "method": (
            "reaplica o dataset atual somente a assertions de saída; "
            "resultados que dependem do workspace mantêm a avaliação original"
        ),
    }
    return rescored_report


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


def validate_selection(
    raw: Any, dataset: dict[str, Any], routes: list[str]
) -> dict[str, list[str]]:
    if not isinstance(raw, dict) or raw.get("version") != 1:
        raise EvaluationError("seleção precisa ser um objeto com version=1")
    raw_cases = raw.get("cases")
    if not isinstance(raw_cases, dict) or not raw_cases:
        raise EvaluationError("selection.cases precisa ser um objeto não vazio")
    known_cases = {case["id"] for case in dataset["cases"]}
    unknown_cases = sorted(set(raw_cases) - known_cases)
    if unknown_cases:
        raise EvaluationError(
            f"seleção contém casos desconhecidos: {', '.join(unknown_cases)}"
        )
    normalized: dict[str, list[str]] = {}
    for case_id, selected_routes in raw_cases.items():
        if (
            not isinstance(selected_routes, list)
            or not selected_routes
            or not all(isinstance(route, str) and route for route in selected_routes)
        ):
            raise EvaluationError(
                f"selection.cases.{case_id} precisa ser uma lista não vazia de rotas"
            )
        if len(set(selected_routes)) != len(selected_routes):
            raise EvaluationError(f"selection.cases.{case_id} contém rotas duplicadas")
        unknown_routes = sorted(set(selected_routes) - set(routes))
        if unknown_routes:
            raise EvaluationError(
                f"selection.cases.{case_id} contém rotas indisponíveis: "
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
        raise EvaluationError(f"não foi possível ler seleção: {error}") from error
    except json.JSONDecodeError as error:
        raise EvaluationError(f"seleção JSON inválida: {error}") from error
    return validate_selection(raw, dataset, routes)


def _result_key(route: str, case_id: str, repetition: int) -> str:
    return json.dumps([route, case_id, repetition], ensure_ascii=False, separators=(",", ":"))


def _sha256_json(value: Any) -> str:
    encoded = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _config_sha256(config_path: Path, config: dict[str, Any]) -> str:
    try:
        content = config_path.read_bytes()
    except OSError:
        content = json.dumps(config, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(content).hexdigest()


def _rubric_sha256(dataset: dict[str, Any]) -> str:
    return _sha256_json(
        [
            {
                "case_id": case["id"],
                "evaluation_mode": case["evaluation_mode"],
                "assertions": case["assertions"],
                "human_rubric": case["human_rubric"],
            }
            for case in dataset["cases"]
        ]
    )


def _engine_identity() -> dict[str, str]:
    benchmark_executor_path = Path(
        sys.modules[BenchmarkExecutor.__module__].__file__
    ).resolve()
    return {
        "quality_eval_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "benchmark_executor_sha256": hashlib.sha256(
            benchmark_executor_path.read_bytes()
        ).hexdigest(),
        "python_implementation": sys.implementation.name,
        "python_version": ".".join(str(part) for part in sys.version_info[:3]),
    }


def _execution_fingerprint(
    execution_config: dict[str, Any],
    safety_adjustments: list[dict[str, str]],
    cli_versions: dict[str, str],
) -> dict[str, Any]:
    basis = {
        "version": 1,
        "effective_config_sha256": _sha256_json(execution_config),
        "safety_adjustments_sha256": _sha256_json(safety_adjustments),
        "cli_versions": dict(sorted(cli_versions.items())),
        "engine": _engine_identity(),
    }
    return {**basis, "sha256": _sha256_json(basis)}


def _attach_execution_profile(
    manifest: dict[str, Any],
    execution_config: dict[str, Any],
    safety_adjustments: list[dict[str, str]],
    cli_versions: dict[str, str],
) -> None:
    execution_fingerprint = _execution_fingerprint(
        execution_config, safety_adjustments, cli_versions
    )
    base_plan_sha256 = manifest["plan_sha256"]
    manifest.update(
        {
            "base_plan_sha256": base_plan_sha256,
            "execution_fingerprint": execution_fingerprint,
            "plan_sha256": _sha256_json(
                {
                    "base_plan_sha256": base_plan_sha256,
                    "execution_fingerprint": execution_fingerprint,
                }
            ),
        }
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

    config_hash = _config_sha256(config_path, config)
    dataset_hash = _sha256_json(dataset)
    rubric_hash = _rubric_sha256(dataset)
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


def _atomic_write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_path, path)
    except Exception:
        if temporary_path.exists():
            trash = shutil.which("trash")
            if trash:
                subprocess.run(
                    [trash, str(temporary_path)],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False,
                )
        raise


def _load_checkpoint(path: Path) -> dict[str, Any]:
    try:
        with path.open(encoding="utf-8") as stream:
            checkpoint = json.load(stream)
    except OSError as error:
        raise EvaluationError(f"não foi possível ler checkpoint: {error}") from error
    except json.JSONDecodeError as error:
        raise EvaluationError(f"checkpoint JSON inválido: {error}") from error
    if (
        not isinstance(checkpoint, dict)
        or checkpoint.get("version") != 2
        or not isinstance(checkpoint.get("manifest"), dict)
        or not isinstance(checkpoint.get("slots"), dict)
        or not isinstance(checkpoint.get("results"), list)
    ):
        raise EvaluationError("checkpoint possui formato inválido")
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
                f"checkpoint possui ambiguous_retry_count inválido no slot {key}"
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
        raise EvaluationError("contagem final de resultados diverge dos slots planejados")


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
    metadata = preflight(
        execution_config, routes, roles, assertion_types, route_roles
    ) if execute is None else {
        "safe_argv": {
            (route, role): None
            for route, selected_roles in route_roles.items()
            for role in selected_roles
        },
        "cli_versions": {},
    }
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
                    checkpoint["slots"][key]["ambiguous_retry_count"] = (
                        int(checkpoint["slots"][key].get("ambiguous_retry_count", 0)) + 1
                    )
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


BLIND_IDENTITY_PATTERN = re.compile(
    r"(?i)(?<![A-Za-z0-9])(?:minimax|m3|glm|5\.2|claude|opus|codex|gpt|5\.6|sol|anthropic|z\.ai|openai)(?![A-Za-z0-9])"
)


def _redact_blind_value(
    value: Any, canaries: list[str] | tuple[str, ...]
) -> tuple[Any, int]:
    if isinstance(value, str):
        redacted, count = BLIND_IDENTITY_PATTERN.subn("[IDENTITY_REDACTED]", value)
        for canary in dict.fromkeys(item for item in canaries if item):
            redacted, canary_count = re.subn(
                re.escape(canary), "[CANARY_REDACTED]", redacted, flags=re.IGNORECASE
            )
            count += canary_count
        return redacted, count
    if isinstance(value, list):
        result: list[Any] = []
        total = 0
        for item in value:
            redacted, count = _redact_blind_value(item, canaries)
            result.append(redacted)
            total += count
        return result, total
    if isinstance(value, dict):
        result_dict: dict[str, Any] = {}
        total = 0
        for key, item in value.items():
            redacted, count = _redact_blind_value(item, canaries)
            result_dict[key] = redacted
            total += count
        return result_dict, total
    return value, 0


def build_anonymous_review_packets(
    report: dict[str, Any], dataset: dict[str, Any], seed: int = 42
) -> tuple[dict[str, Any], dict[str, Any]]:
    cases = {case["id"]: case for case in dataset["cases"]}
    candidates: list[
        tuple[dict[str, Any], dict[str, Any], tuple[str, ...]]
    ] = []
    for result in report["results"]:
        case = cases[result["case_id"]]
        if case["human_rubric"] is None:
            continue
        turn_results = result.get("turn_results") or [
            {"turn": 1, "output": result.get("output", "")}
        ]
        blind_item = {
            "case_id": case["id"],
            "category": case["category"],
            "difficulty": case["difficulty"],
            "evaluation_mode": case["evaluation_mode"],
            "repetition": result["repetition"],
            "user_turns": case["turns"],
            "assistant_turns": [item.get("output", "") for item in turn_results],
            "human_rubric": case["human_rubric"],
        }
        mapping_item = {
            "route": result["route"],
            "case_id": case["id"],
            "repetition": result["repetition"],
            "output_sha256": result["output_sha256"],
        }
        canaries = tuple(
            canary
            for canary in (dataset.get("canary"), case.get("canary"))
            if canary
        )
        candidates.append((blind_item, mapping_item, canaries))
    human_evaluation = dataset.get("human_evaluation")
    if human_evaluation is None or human_evaluation.get("randomize_output_order", True):
        random.Random(seed).shuffle(candidates)

    blind_items: list[dict[str, Any]] = []
    mapping_items: list[dict[str, Any]] = []
    redaction_count = 0
    for index, (blind_item, mapping_item, canaries) in enumerate(candidates, start=1):
        candidate_id = f"candidate-{index:04d}"
        redacted, count = _redact_blind_value(blind_item, canaries)
        redaction_count += count
        blind_items.append({"candidate_id": candidate_id, **redacted})
        mapping_items.append({"candidate_id": candidate_id, **mapping_item})

    common = {
        "version": 1,
        "generated_at": report["generated_at"],
        "plan_sha256": report["plan_sha256"],
        "rubric_sha256": report["rubric_sha256"],
    }
    blind_packet = {
        **common,
        "instructions": (
            "Avalie cada candidato somente pelos turnos e pela rubrica. "
            "Preencha uma nota por critério dentro da escala declarada."
        ),
        "identity_redaction_count": redaction_count,
        "human_evaluation": human_evaluation,
        "candidates": blind_items,
    }
    mapping_packet = {**common, "candidates": mapping_items}
    return blind_packet, mapping_packet


def render_markdown(report: dict[str, Any]) -> str:
    summary = report["summary"]
    lines = [
        "# Benchmark de qualidade",
        "",
        f"Chamadas físicas planejadas: {report['calls']}",
    ]
    if report.get("physical_call_accounting") == "upper_bound":
        lines.extend(
            [
                "Limite superior de chamadas físicas após retries ambiguous: "
                f"{report['physical_calls_upper_bound']}",
                "Chamadas associadas a resultados concluídos: "
                f"{report['recorded_result_calls']}",
            ]
        )
    else:
        lines.append(
            "Chamadas físicas executadas: "
            f"{report.get('executed_calls', report.get('recorded_result_calls', report['calls']))}"
        )
    lines.extend(
        [
            f"Repetições: {report['repetitions']}",
            f"Escopo: {report['scope']}",
            f"Score geral: {summary['overall']['mean']:.2f}%",
            "",
            "## Resultado por rota",
            "",
            "| Rota | Média | Mediana | Pior | Aprovação |",
            "| --- | ---: | ---: | ---: | ---: |",
        ]
    )
    for route, stats in summary["by_route"].items():
        lines.append(
            f"| {route} | {stats['mean']:.2f}% | {stats['median']:.2f}% | "
            f"{stats['worst']:.2f}% | {stats['pass_rate']:.2f}% |"
        )
    lines.extend(
        [
            "",
            "## Resultado por categoria",
            "",
            "| Categoria | Média | Mediana | Pior | Aprovação |",
            "| --- | ---: | ---: | ---: | ---: |",
        ]
    )
    for category, stats in summary["by_category"].items():
        safe_category = category.replace("|", "\\|")
        lines.append(
            f"| {safe_category} | {stats['mean']:.2f}% | {stats['median']:.2f}% | "
            f"{stats['worst']:.2f}% | {stats['pass_rate']:.2f}% |"
        )
    lines.extend(
        [
            "",
            "## Resultado por dificuldade",
            "",
            "| Dificuldade | Média | Mediana | Pior | Aprovação |",
            "| --- | ---: | ---: | ---: | ---: |",
        ]
    )
    for difficulty, stats in summary.get("by_difficulty", {}).items():
        lines.append(
            f"| {difficulty} | {stats['mean']:.2f}% | {stats['median']:.2f}% | "
            f"{stats['worst']:.2f}% | {stats['pass_rate']:.2f}% |"
        )
    lines.extend(
        [
            "",
            "## Resultado por rota e categoria",
            "",
            "| Rota | Categoria | Média | Mediana | Pior | Aprovação |",
            "| --- | --- | ---: | ---: | ---: | ---: |",
        ]
    )
    for route, categories in summary["by_route_category"].items():
        for category, stats in categories.items():
            safe_category = category.replace("|", "\\|")
            lines.append(
                f"| {route} | {safe_category} | {stats['mean']:.2f}% | "
                f"{stats['median']:.2f}% | {stats['worst']:.2f}% | "
                f"{stats['pass_rate']:.2f}% |"
            )
    lines.extend(
        [
            "",
            "## Resultado por rota, categoria e dificuldade",
            "",
            "| Rota | Categoria | Dificuldade | Média | Mediana | Pior | Aprovação |",
            "| --- | --- | --- | ---: | ---: | ---: | ---: |",
        ]
    )
    for route, categories in summary.get("by_route_category_difficulty", {}).items():
        for category, difficulties in categories.items():
            for difficulty, stats in difficulties.items():
                safe_category = category.replace("|", "\\|")
                lines.append(
                    f"| {route} | {safe_category} | {difficulty} | {stats['mean']:.2f}% | "
                    f"{stats['median']:.2f}% | {stats['worst']:.2f}% | "
                    f"{stats['pass_rate']:.2f}% |"
                )
    lines.extend(
        [
            "",
            "## Execuções",
            "",
            "| Rota | Papel | Caso | Repetição | Status | Score | SHA-256 |",
            "| --- | --- | --- | ---: | --- | ---: | --- |",
        ]
    )
    for result in report["results"]:
        lines.append(
            f"| {result['route']} | {result['role']} | {result['case_id']} | "
            f"{result['repetition']} | "
            f"{result['status']} | {result['score']:.2f}% | `{result['output_sha256']}` |"
        )
    return "\n".join(lines) + "\n"


def write_reports(output_path: Path, report: dict[str, Any]) -> tuple[Path, Path]:
    if output_path.suffix.lower() != ".json":
        raise EvaluationError("--output precisa terminar em .json")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    markdown_path = output_path.with_suffix(".md")
    output_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    markdown_path.write_text(render_markdown(report), encoding="utf-8")
    return output_path, markdown_path


def write_anonymous_review_packets(
    output_path: Path,
    report: dict[str, Any],
    dataset: dict[str, Any],
    seed: int,
    blind_dir: Path | None = None,
    mapping_dir: Path | None = None,
) -> tuple[Path, Path] | None:
    if not any(
        case["human_rubric"] is not None for case in dataset["cases"]
    ):
        return None
    blind_packet, mapping_packet = build_anonymous_review_packets(report, dataset, seed)
    resolved_blind_dir = (
        blind_dir or output_path.with_name(f"{output_path.stem}-human-review")
    ).expanduser().resolve()
    resolved_mapping_dir = (
        mapping_dir or output_path.with_name(f"{output_path.stem}-human-mapping")
    ).expanduser().resolve()
    if (
        resolved_blind_dir == resolved_mapping_dir
        or resolved_blind_dir.is_relative_to(resolved_mapping_dir)
        or resolved_mapping_dir.is_relative_to(resolved_blind_dir)
    ):
        raise EvaluationError(
            "os diretórios de avaliação cega e mapping precisam ser separados"
        )
    resolved_blind_dir.mkdir(parents=True, exist_ok=True)
    resolved_mapping_dir.mkdir(parents=True, mode=0o700, exist_ok=True)
    os.chmod(resolved_mapping_dir, 0o700)
    blind_path = resolved_blind_dir / "review.json"
    mapping_path = resolved_mapping_dir / "mapping.json"
    _atomic_write_json(blind_path, blind_packet)
    _atomic_write_json(mapping_path, mapping_packet)
    os.chmod(mapping_path, 0o600)
    return blind_path, mapping_path


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Executa um benchmark determinístico de qualidade das rotas"
    )
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--cases", required=True, type=Path)
    parser.add_argument("--routes", help="nomes de rotas separados por vírgula; padrão: todas")
    parser.add_argument(
        "--selection",
        type=Path,
        help="JSON opcional que seleciona as rotas executadas em cada caso",
    )
    parser.add_argument("--repetitions", type=int, default=3)
    parser.add_argument("--parallel", type=int, default=1)
    parser.add_argument("--max-calls", type=int, default=72)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--output", required=True, type=Path, help="relatório JSON")
    parser.add_argument("--validate-only", action="store_true")
    parser.add_argument(
        "--manifest-output", type=Path, help="grava o manifesto do dry-run em JSON"
    )
    parser.add_argument(
        "--checkpoint", type=Path, help="checkpoint atômico; padrão derivado de --output"
    )
    parser.add_argument("--resume", action="store_true", help="retoma um checkpoint existente")
    parser.add_argument(
        "--retry-ambiguous",
        action="store_true",
        help="repete slots ambiguous com aumento explícito de --max-calls",
    )
    parser.add_argument(
        "--replay-report",
        type=Path,
        help="reavalia saídas de um relatório existente sem chamar modelos",
    )
    parser.add_argument(
        "--human-review-dir",
        type=Path,
        help="diretório que receberá somente o pacote cego",
    )
    parser.add_argument(
        "--human-mapping-dir",
        type=Path,
        help="diretório privado separado que receberá o mapping",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        repetitions = _positive_int(args.repetitions, "--repetitions")
        parallel = _positive_int(args.parallel, "--parallel")
        max_calls = _positive_int(args.max_calls, "--max-calls")
        config_path = args.config.expanduser().resolve()
        cases_path = args.cases.expanduser().resolve()
        output_path = args.output.expanduser().resolve()
        if output_path.suffix.lower() != ".json":
            raise EvaluationError("--output precisa terminar em .json")
        config = load_config(config_path)
        dataset = load_dataset(cases_path)
        if args.replay_report is not None:
            if args.validate_only:
                raise EvaluationError("--replay-report não pode ser combinado com --validate-only")
            source_path = args.replay_report.expanduser().resolve()
            if source_path == output_path:
                raise EvaluationError("--output precisa ser diferente de --replay-report")
            report = rescore_output_only_report(load_report(source_path), dataset, source_path)
            report["audit"]["rescore_dataset_source"] = str(cases_path)
            report["audit"]["rescore_dataset_source_sha256"] = hashlib.sha256(
                cases_path.read_bytes()
            ).hexdigest()
            json_path, markdown_path = write_reports(output_path, report)
            print(f"relatórios reavaliados: {json_path} e {markdown_path}")
            return 0
        requested_routes = parse_routes(args.routes)
        available_routes = validate_routes(config, requested_routes, set())
        selection = (
            load_selection(
                args.selection.expanduser().resolve(), dataset, available_routes
            )
            if args.selection is not None
            else None
        )
        selected_cases = [
            case
            for case in dataset["cases"]
            if selection is None or case["id"] in selection
        ]
        roles = {case["role"] for case in selected_cases}
        if selection is None:
            routes = validate_routes(config, requested_routes, roles)
        else:
            routes = available_routes
            routes = [
                route
                for route in routes
                if any(route in selected_routes for selected_routes in selection.values())
            ]
            for route in routes:
                required_roles = {
                    case["role"]
                    for case in selected_cases
                    if route in selection.get(case["id"], [])
                }
                validate_routes(config, [route], required_roles)
        manifest = build_execution_manifest(
            config_path,
            config,
            dataset,
            routes,
            repetitions,
            args.seed,
            selection,
        )
        call_count = manifest["physical_call_count"]
        if call_count > max_calls:
            raise EvaluationError(
                f"benchmark exigiria {call_count} chamadas, acima de --max-calls={max_calls}"
            )
        if args.manifest_output is not None:
            manifest_path = args.manifest_output.expanduser().resolve()
            if manifest_path.suffix.lower() != ".json":
                raise EvaluationError("--manifest-output precisa terminar em .json")
            _atomic_write_json(manifest_path, manifest)
        if args.validate_only:
            selected_cases = [
                case
                for case in dataset["cases"]
                if selection is None or case["id"] in selection
            ]
            selected_roles = {case["role"] for case in selected_cases}
            route_roles = {
                route: {
                    case["role"]
                    for case in selected_cases
                    if selection is None or route in selection.get(case["id"], [])
                }
                for route in routes
            }
            execution_config, _ = prepare_execution_config(
                config, routes, selected_roles, route_roles
            )
            preflight(
                execution_config,
                routes,
                selected_roles,
                {
                    assertion["type"]
                    for case in selected_cases
                    for assertion in case["assertions"]
                },
                route_roles,
            )
            print(
                f"válido: {len(selected_cases)} casos, {len(routes)} rotas, "
                f"{manifest['slot_count']} slots e {call_count} chamadas físicas planejadas"
            )
            return 0
        checkpoint_path = (
            args.checkpoint.expanduser().resolve()
            if args.checkpoint is not None
            else output_path.with_name(f"{output_path.stem}.checkpoint.json")
        )
        report = run_benchmark(
            config_path,
            config,
            dataset,
            routes,
            repetitions,
            parallel,
            max_calls,
            args.seed,
            progress=True,
            checkpoint_path=checkpoint_path,
            resume=args.resume,
            retry_ambiguous=args.retry_ambiguous,
            selection=selection,
        )
        report["cases"] = str(cases_path)
        report["dataset_source_sha256"] = hashlib.sha256(cases_path.read_bytes()).hexdigest()
        json_path, markdown_path = write_reports(output_path, report)
        human_paths = write_anonymous_review_packets(
            output_path,
            report,
            dataset,
            args.seed,
            args.human_review_dir,
            args.human_mapping_dir,
        )
        print(f"relatórios: {json_path} e {markdown_path}")
        if human_paths is not None:
            print(f"avaliação humana cega: {human_paths[0]}")
        return 0
    except (ConfigError, EvaluationError, OSError) as error:
        print(f"erro: {error}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("benchmark interrompido", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
