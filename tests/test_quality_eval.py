from __future__ import annotations

import hashlib
import importlib
import io
import json
import os
import random
import re
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from collections import Counter
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

import quality_eval
from benchmark_executor import BenchmarkExecutor, ProcessResult, select_claude_effort
from qeval.fingerprint import (
    _collect_engine_sources,
    _engine_aggregate_sha256,
    _engine_source_manifest,
)
from quality_eval import (
    EvaluationError,
    _atomic_write_json,
    _audit_files,
    _execution_fingerprint,
    _make_executor,
    _snapshot_files,
    build_anonymous_review_packets,
    build_execution_manifest,
    evaluate_assertions,
    main,
    parse_args,
    prepare_execution_config,
    planned_call_count,
    rescore_output_only_report,
    render_markdown,
    run_benchmark,
    validate_dataset,
    validate_routes,
    validate_selection,
    write_anonymous_review_packets,
)

requires_benchmark_sandbox = unittest.skipUnless(
    sys.platform == "darwin"
    and Path("/usr/bin/sandbox-exec").is_file()
    and quality_eval.SANDBOX_PYTHON.is_file(),
    "requires the macOS benchmark sandbox and Xcode Python",
)


def make_dataset(cases: list[dict[str, object]]) -> dict[str, object]:
    return validate_dataset({"version": 1, "cases": cases})


def make_case(**overrides: object) -> dict[str, object]:
    case: dict[str, object] = {
        "id": "simple",
        "category": "text",
        "prompt": "Responda com OK.",
        "assertions": [{"type": "output_regex", "pattern": "^OK$"}],
    }
    case.update(overrides)
    return case


def make_human_rubric() -> dict[str, object]:
    return {
        "criteria": [
            {"id": "quality", "description": "Qualidade da resposta", "weight": 60},
            {"id": "clarity", "description": "Clareza da resposta", "weight": 40},
        ],
        "scale": {"min": 1, "max": 5},
    }


def make_v2_case(**overrides: object) -> dict[str, object]:
    case: dict[str, object] = {
        "id": "v2-simple",
        "category": "discussion",
        "difficulty": "simple",
        "evaluation_mode": "objective",
        "prompt": "Responda com OK.",
        "assertions": [{"type": "output_regex", "pattern": "^OK$"}],
    }
    case.update(overrides)
    if "turns" in overrides:
        case.pop("prompt", None)
    return case


class FacadeCompatibilityTests(unittest.TestCase):
    def test_facade_delegates_implementation_to_qeval_modules(self) -> None:
        expected_modules = {
            "_atomic_write_json": "qeval.persistence",
            "_execute_work_item": "qeval.execution",
            "_execution_fingerprint": "qeval.fingerprint",
            "_make_executor": "qeval.executor",
            "_run_sandboxed_python": "qeval.sandbox",
            "_snapshot_files": "qeval.filesystem",
            "_truncate_capture": "qeval.textutil",
            "build_execution_manifest": "qeval.manifest",
            "evaluate_assertions": "qeval.assertions",
            "prepare_execution_config": "qeval.execution_config",
            "render_markdown": "qeval.reporting",
            "run_benchmark": "qeval.orchestration",
            "validate_dataset": "qeval.validation",
        }

        for symbol, module_name in expected_modules.items():
            with self.subTest(symbol=symbol):
                implementation = getattr(importlib.import_module(module_name), symbol)
                self.assertIs(getattr(quality_eval, symbol), implementation)

    def test_qeval_modules_import_without_loading_facade(self) -> None:
        project_root = Path(__file__).resolve().parents[1]
        module_names = sorted(
            f"qeval.{path.stem}"
            for path in (project_root / "qeval").glob("*.py")
            if path.stem != "__init__"
        )
        script = (
            "import importlib, sys\n"
            f"modules = {module_names!r}\n"
            "for module in modules:\n"
            "    importlib.import_module(module)\n"
            "assert 'quality_eval' not in sys.modules\n"
        )

        completed = subprocess.run(
            [sys.executable, "-c", script],
            cwd=project_root,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=10,
            check=False,
        )

        self.assertEqual(completed.returncode, 0, completed.stdout)


class DatasetValidationTests(unittest.TestCase):
    def test_defaults_to_judge_without_allowed_files(self) -> None:
        dataset = make_dataset([make_case()])

        case = dataset["cases"][0]
        self.assertEqual(case["role"], "judge")
        self.assertEqual(case["allowed_files"], [])
        self.assertFalse(case["assertions"][0]["critical"])

    def test_accepts_file_key_and_path_alias(self) -> None:
        dataset = make_dataset(
            [
                make_case(
                    role="worker",
                    allowed_files=["result.txt"],
                    assertions=[
                        {
                            "type": "file_regex",
                            "file": "result.txt",
                            "pattern": "done",
                            "critical": True,
                        },
                        {
                            "type": "file_not_regex",
                            "path": "result.txt",
                            "pattern": "TODO",
                        },
                    ],
                )
            ]
        )

        assertions = dataset["cases"][0]["assertions"]
        self.assertEqual(assertions[0]["file"], "result.txt")
        self.assertEqual(assertions[1]["file"], "result.txt")
        self.assertTrue(assertions[0]["critical"])

    def test_rejects_unsafe_fixture_path(self) -> None:
        with self.assertRaisesRegex(EvaluationError, "safe relative path"):
            make_dataset([make_case(files={"../outside.txt": "x"})])

    def test_v2_accepts_difficulty_hybrid_rubric_and_two_turns(self) -> None:
        dataset = validate_dataset(
            {
                "version": 2,
                "cases": [
                    make_v2_case(
                        difficulty="hard",
                        evaluation_mode="hybrid",
                        turns=[{"user": "Primeiro turno"}, {"user": "Segundo turno"}],
                        human_rubric=make_human_rubric(),
                    )
                ],
            }
        )

        case = dataset["cases"][0]
        self.assertEqual(case["difficulty"], "hard")
        self.assertEqual(case["evaluation_mode"], "hybrid")
        self.assertEqual(case["turns"], ["Primeiro turno", "Segundo turno"])
        self.assertEqual(sum(item["weight"] for item in case["human_rubric"]["criteria"]), 100)

    def test_v2_preserves_human_evaluation_scale_and_case_canary(self) -> None:
        human_evaluation = {
            "blind": True,
            "randomize_output_order": True,
            "pairwise_comparison": True,
            "dimension_scale": {"minimum": 1, "maximum": 7},
            "retain_rationales": True,
        }
        dataset = validate_dataset(
            {
                "version": 2,
                "human_evaluation": human_evaluation,
                "cases": [
                    make_v2_case(
                        canary="CASE-CANARY",
                        evaluation_mode="human",
                        assertions=[],
                        human_rubric=[
                            {
                                "dimension": "quality",
                                "description": "Qualidade da resposta",
                                "weight": 100,
                            }
                        ],
                    )
                ],
            }
        )

        self.assertEqual(dataset["human_evaluation"], human_evaluation)
        self.assertEqual(dataset["cases"][0]["canary"], "CASE-CANARY")
        self.assertEqual(
            dataset["cases"][0]["human_rubric"]["scale"],
            {"min": 1.0, "max": 7.0},
        )

    def test_command_rejects_shell_and_flags_outside_safe_prefix(self) -> None:
        for argv in (
            ["/bin/sh", "-c", "echo unsafe"],
            [
                "uv",
                "run",
                "--no-project",
                "--no-python-downloads",
                "python",
                "-E",
                "test_ok.py",
            ],
        ):
            with self.subTest(argv=argv), self.assertRaisesRegex(
                EvaluationError, "safe prefix|only a relative Python script or -c"
            ):
                make_dataset([make_case(assertions=[{"type": "command", "argv": argv}])])

    def test_v2_human_case_allows_empty_objective_assertions(self) -> None:
        dataset = validate_dataset(
            {
                "version": 2,
                "cases": [
                    make_v2_case(
                        evaluation_mode="human",
                        assertions=[],
                        human_rubric=make_human_rubric(),
                    )
                ],
            }
        )

        self.assertEqual(dataset["cases"][0]["assertions"], [])

    def test_v2_rejects_invalid_difficulty_and_unbalanced_rubric(self) -> None:
        with self.assertRaisesRegex(EvaluationError, "difficulty"):
            validate_dataset(
                {
                    "version": 2,
                    "cases": [make_v2_case(difficulty="extreme")],
                }
            )
        rubric = make_human_rubric()
        rubric["criteria"][0]["weight"] = 10
        with self.assertRaisesRegex(EvaluationError, "weights must total 100"):
            validate_dataset(
                {
                    "version": 2,
                    "cases": [
                        make_v2_case(
                            evaluation_mode="human",
                            assertions=[],
                            human_rubric=rubric,
                        )
                    ],
                }
            )


class AssertionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.cwd = Path(tempfile.mkdtemp(prefix="llm-router-quality-test-"))

    @requires_benchmark_sandbox
    def test_weighted_scoring_and_json_code_fence(self) -> None:
        (self.cwd / "result.txt").write_text("done\n", encoding="utf-8")
        (self.cwd / "test_ok.py").write_text("raise SystemExit(0)\n", encoding="utf-8")
        (self.cwd / "mathutil.py").write_text(
            "def add(left, right):\n    return left + right\n", encoding="utf-8"
        )
        assertions = make_dataset(
            [
                make_case(
                    assertions=[
                        {
                            "type": "output_json_equals",
                            "path": "result.value",
                            "expected": 7,
                            "weight": 3,
                        },
                        {
                            "type": "output_not_regex",
                            "pattern": "inventado",
                            "weight": 1,
                        },
                        {
                            "type": "file_regex",
                            "file": "result.txt",
                            "pattern": "^done$",
                            "weight": 1,
                        },
                        {
                            "type": "command",
                            "argv": [
                                "uv",
                                "run",
                                "--no-project",
                                "--no-python-downloads",
                                "python",
                                "test_ok.py",
                            ],
                            "weight": 1,
                        },
                        {
                            "type": "command",
                            "argv": [
                                "uv",
                                "run",
                                "--no-project",
                                "--no-python-downloads",
                                "python",
                                "-c",
                                "from mathutil import add; assert add(2, 3) == 5",
                            ],
                            "weight": 1,
                        },
                    ]
                )
            ]
        )["cases"][0]["assertions"]

        score, results = evaluate_assertions(
            assertions, '```json\n{"result":{"value":7}}\n```', self.cwd
        )

        self.assertEqual(score, 100.0)
        self.assertTrue(all(result["passed"] for result in results))

    def test_failed_weight_reduces_score(self) -> None:
        assertions = make_dataset(
            [
                make_case(
                    assertions=[
                        {"type": "output_regex", "pattern": "OK", "weight": 3},
                        {
                            "type": "output_regex",
                            "pattern": "missing",
                            "weight": 1,
                            "critical": True,
                        },
                    ]
                )
            ]
        )["cases"][0]["assertions"]

        score, results = evaluate_assertions(assertions, "OK", self.cwd)

        self.assertEqual(score, 75.0)
        self.assertTrue(results[0]["passed"])
        self.assertFalse(results[1]["passed"])
        self.assertTrue(results[1]["critical"])

    def test_json_one_of_accepts_semantically_equivalent_values(self) -> None:
        assertions = make_dataset(
            [
                make_case(
                    assertions=[
                        {
                            "type": "output_json_one_of",
                            "path": "threshold",
                            "expected": [0.005, "0.5%"],
                        }
                    ]
                )
            ]
        )["cases"][0]["assertions"]

        score, results = evaluate_assertions(assertions, '{"threshold":"0.5%"}', self.cwd)

        self.assertEqual(score, 100.0)
        self.assertTrue(results[0]["passed"])

    def test_strict_json_object_rejects_fences_extra_text_and_arrays(self) -> None:
        assertions = validate_dataset(
            {
                "version": 2,
                "cases": [
                    make_v2_case(assertions=[{"type": "output_strict_json_object"}])
                ],
            }
        )["cases"][0]["assertions"]

        accepted_score, accepted = evaluate_assertions(
            assertions, '{"result":"ok"}', self.cwd
        )
        rejected = [
            '```json\n{"result":"ok"}\n```',
            'Resposta: {"result":"ok"}',
            '[{"result":"ok"}]',
            '{"result":NaN}',
            '{"result":Infinity}',
            '{"result":-Infinity}',
        ]

        self.assertEqual(accepted_score, 100.0)
        self.assertTrue(accepted[0]["passed"])
        for output in rejected:
            with self.subTest(output=output):
                score, results = evaluate_assertions(assertions, output, self.cwd)
                self.assertEqual(score, 0.0)
                self.assertFalse(results[0]["passed"])

    def test_v2_extended_assertion_families(self) -> None:
        (self.cwd / "users.py").write_text(
            "normalize(email)\nnormalize(email)\n", encoding="utf-8"
        )
        raw_assertions = [
            {
                "type": "file_regex_count",
                "file": "users.py",
                "pattern": "normalize\\(email\\)",
                "minimum": 2,
                "maximum": 2,
            },
            {
                "type": "output_character_count_range",
                "path": "posts[*]",
                "minimum": 1,
                "maximum": 20,
            },
            {
                "type": "output_each_regex",
                "paths": ["linkedin", "x"],
                "pattern": "launch",
            },
            {
                "type": "output_hashtag_count_max",
                "paths": ["linkedin", "x"],
                "maximum": 2,
            },
            {
                "type": "output_json_all_match",
                "path": "ideas[*]",
                "required_keys": ["idea", "target_pain"],
            },
            {"type": "output_json_length", "path": "ideas", "expected": 2},
            {
                "type": "output_json_length_range",
                "path": "findings",
                "minimum": 3,
                "maximum": 3,
            },
            {
                "type": "output_json_number_range",
                "path": "experiments[*].cost",
                "minimum": 0,
                "maximum": 5000,
            },
            {
                "type": "output_json_sum_max",
                "path": "experiments[*].cost",
                "maximum": 5000,
            },
            {
                "type": "output_json_values_in",
                "path": "ideas[*].target_pain",
                "allowed": ["x", "y"],
            },
            {
                "type": "output_regex_count",
                "pattern": "needle",
                "minimum": 2,
                "maximum": 2,
            },
            {
                "type": "output_unique_values",
                "path": "ideas[*].idea",
                "minimum_unique": 2,
            },
            {
                "type": "output_word_count_range",
                "path": "body",
                "minimum": 3,
                "maximum": 3,
            },
        ]
        assertions = validate_dataset(
            {
                "version": 2,
                "cases": [make_v2_case(assertions=raw_assertions)],
            }
        )["cases"][0]["assertions"]
        output = json.dumps(
            {
                "posts": ["one", "two"],
                "linkedin": "launch #one #two",
                "x": "launch #one",
                "ideas": [
                    {"idea": "A", "target_pain": "x"},
                    {"idea": "B", "target_pain": "y"},
                ],
                "findings": [1, 2, 3],
                "experiments": [{"cost": 2000}, {"cost": 2500}],
                "body": "one two three",
                "tag": "needle needle",
            }
        )

        score, results = evaluate_assertions(assertions, output, self.cwd)

        self.assertEqual(score, 100.0)
        self.assertEqual(len(results), 13)
        self.assertTrue(all(result["passed"] for result in results))

    def test_v2_dataset_specific_json_and_pattern_assertions(self) -> None:
        raw_assertions = [
            {
                "type": "output_all_patterns",
                "patterns": ["Acme CLI 2\\.4", "sync --dry-run"],
            },
            {
                "type": "output_json_all_non_empty",
                "path": "items[*]",
                "required_keys": ["name", "details"],
            },
            {
                "type": "output_json_all_patterns",
                "path": "linkedin",
                "patterns": ["120", "Recife"],
            },
            {
                "type": "output_json_ends_with_path",
                "text_path": "post",
                "suffix_path": "cta",
                "require_non_empty": True,
            },
            {
                "type": "output_json_last_item_regex",
                "path": "posts",
                "pattern": "\\?\\s*$",
            },
            {
                "type": "output_json_all_lengths",
                "path": "segments[*].proof_bullets",
                "expected": 2,
            },
            {"type": "output_json_all_non_empty_values", "path": "landing_page"},
            {"type": "output_json_non_empty", "path": "cta"},
        ]
        assertions = validate_dataset(
            {
                "version": 2,
                "cases": [make_v2_case(assertions=raw_assertions)],
            }
        )["cases"][0]["assertions"]
        output = json.dumps(
            {
                "reference": "Acme CLI 2.4 supports sync --dry-run",
                "items": [{"name": "one", "details": "useful"}],
                "linkedin": "120 users in Recife",
                "post": "Try it now",
                "cta": "now",
                "posts": ["First", "What next?"],
                "segments": [
                    {"proof_bullets": ["a", "b"]},
                    {"proof_bullets": ["c", "d"]},
                ],
                "landing_page": ["hero", "proof"],
            }
        )

        score, results = evaluate_assertions(assertions, output, self.cwd)

        self.assertEqual(score, 100.0)
        self.assertEqual(len(results), 8)
        self.assertTrue(all(result["passed"] for result in results))

    @requires_benchmark_sandbox
    def test_python_behavior_runs_fixed_probes_without_public_expected_values(self) -> None:
        (self.cwd / "mathutil.py").write_text(
            "def add(left, right):\n"
            "    return left + right\n\n"
            "def divide(left, right):\n"
            "    return left / right\n",
            encoding="utf-8",
        )
        assertions = validate_dataset(
            {
                "version": 2,
                "cases": [
                    make_v2_case(
                        assertions=[
                            {
                                "type": "python_behavior",
                                "probes": [
                                    {
                                        "id": "add",
                                        "module": "mathutil",
                                        "call": "add",
                                        "args": [2, 3],
                                        "expected_return": 5,
                                        "expected_type": "int",
                                    },
                                    {
                                        "id": "zero-division",
                                        "module": "mathutil",
                                        "call": "divide",
                                        "args": [1, 0],
                                        "expected_exception": "ZeroDivisionError",
                                    },
                                ],
                                "timeout_seconds": 5,
                            }
                        ]
                    )
                ],
            }
        )["cases"][0]["assertions"]

        score, results = evaluate_assertions(assertions, "OK", self.cwd)

        self.assertEqual(score, 100.0)
        self.assertTrue(results[0]["passed"])
        self.assertEqual(
            set(results[0]["probes"][0]),
            {"id", "passed", "request_sha256", "response_sha256"},
        )
        self.assertNotIn("expected", json.dumps(results, ensure_ascii=False))

    @requires_benchmark_sandbox
    def test_python_behavior_allows_imports_from_the_fixture(self) -> None:
        (self.cwd / "money.py").write_text(
            "def format_usd(cents):\n    return f'${cents / 100:.2f}'\n",
            encoding="utf-8",
        )
        (self.cwd / "invoice.py").write_text(
            "from money import format_usd\n\n"
            "def total(cents):\n    return format_usd(cents)\n",
            encoding="utf-8",
        )
        assertions = validate_dataset(
            {
                "version": 2,
                "cases": [
                    make_v2_case(
                        assertions=[
                            {
                                "type": "python_behavior",
                                "probes": [
                                    {
                                        "id": "local-import",
                                        "module": "invoice",
                                        "call": "total",
                                        "args": [1234],
                                        "expected_return": "$12.34",
                                    }
                                ],
                            }
                        ]
                    )
                ],
            }
        )["cases"][0]["assertions"]

        score, results = evaluate_assertions(assertions, "OK", self.cwd)

        self.assertEqual(score, 100.0)
        self.assertTrue(results[0]["passed"])

    @requires_benchmark_sandbox
    def test_python_behavior_expected_secret_never_reaches_child_frames(self) -> None:
        (self.cwd / "probe.py").write_text(
            "import sys\n\n"
            "def scan_parent_frames():\n"
            "    needle = bytes([83, 69, 67, 82, 69, 84, 95, 67, 72, 73, 76, 68, 95, 77, 65, 82, 75, 69, 82]).decode()\n"
            "    frame = sys._getframe().f_back\n"
            "    while frame is not None:\n"
            "        values = list(frame.f_locals.values()) + list(frame.f_code.co_consts)\n"
            "        if any(isinstance(value, str) and needle in value for value in values):\n"
            "            return needle\n"
            "        frame = frame.f_back\n"
            "    return 'CLEAN'\n",
            encoding="utf-8",
        )
        assertions = validate_dataset(
            {
                "version": 2,
                "cases": [
                    make_v2_case(
                        assertions=[
                            {
                                "type": "python_behavior",
                                "probes": [
                                    {
                                        "id": "secret-stays-in-controller",
                                        "module": "probe",
                                        "call": "scan_parent_frames",
                                        "expected_return": "SECRET_CHILD_MARKER",
                                    },
                                    {
                                        "id": "scanner-control",
                                        "module": "probe",
                                        "call": "scan_parent_frames",
                                        "expected_return": "CLEAN",
                                    },
                                ],
                            }
                        ]
                    )
                ],
            }
        )["cases"][0]["assertions"]

        score, results = evaluate_assertions(assertions, "OK", self.cwd)

        self.assertEqual(score, 0.0)
        self.assertFalse(results[0]["probes"][0]["passed"])
        self.assertTrue(results[0]["probes"][1]["passed"])
        self.assertNotIn("SECRET_CHILD_MARKER", json.dumps(results))

    def test_python_behavior_child_payload_excludes_expected_values(self) -> None:
        (self.cwd / "probe.py").write_text(
            "def value():\n    return 'unused'\n", encoding="utf-8"
        )
        assertions = validate_dataset(
            {
                "version": 2,
                "cases": [
                    make_v2_case(
                        assertions=[
                            {
                                "type": "python_behavior",
                                "probes": [
                                    {
                                        "id": "payload",
                                        "module": "probe",
                                        "call": "value",
                                        "expected_return": "SECRET_CHILD_MARKER",
                                    }
                                ],
                            }
                        ]
                    )
                ],
            }
        )["cases"][0]["assertions"]
        captured: dict[str, object] = {}

        def fake_grader(*args: object, **kwargs: object) -> dict[str, object]:
            captured.update(json.loads(str(kwargs["stdin_source"])))
            response = {
                "status": "returned",
                "type": "str",
                "value": "SECRET_CHILD_MARKER",
            }
            return {
                "status": "completed",
                "exit_code": 0,
                "_stdout": json.dumps(response) + "\n",
                "_stderr": "",
                "stdout_sha256": "response-hash",
            }

        with patch("qeval.sandbox._run_sandboxed_python", side_effect=fake_grader):
            score, results = evaluate_assertions(assertions, "OK", self.cwd)

        self.assertEqual(score, 100.0)
        self.assertTrue(results[0]["passed"])
        self.assertEqual(set(captured), {"module", "call", "args", "kwargs"})
        self.assertNotIn("SECRET_CHILD_MARKER", json.dumps(captured))

    @requires_benchmark_sandbox
    def test_python_behavior_blocks_external_file_write(self) -> None:
        external_path = Path("/tmp/llm-router-quality-sandbox-write-probe-20260721.txt")
        self.assertFalse(external_path.exists())
        (self.cwd / "writer.py").write_text(
            "def write_file(path):\n"
            "    with open(path, 'w', encoding='utf-8') as stream:\n"
            "        stream.write('blocked')\n",
            encoding="utf-8",
        )
        assertions = validate_dataset(
            {
                "version": 2,
                "cases": [
                    make_v2_case(
                        assertions=[
                            {
                                "type": "python_behavior",
                                "probes": [
                                    {
                                        "id": "write-denied",
                                        "module": "writer",
                                        "call": "write_file",
                                        "args": [str(external_path)],
                                        "expected_exception": "PermissionError",
                                    }
                                ],
                            }
                        ]
                    )
                ],
            }
        )["cases"][0]["assertions"]

        score, results = evaluate_assertions(assertions, "OK", self.cwd)

        self.assertEqual(score, 100.0)
        self.assertTrue(results[0]["passed"])
        self.assertFalse(external_path.exists())

    @requires_benchmark_sandbox
    def test_python_behavior_blocks_external_file_read(self) -> None:
        external_root = Path(tempfile.mkdtemp(prefix="llm-router-quality-external-"))
        external_path = external_root / "secret.txt"
        external_path.write_text("PRIVATE_TMP_MARKER", encoding="utf-8")
        (self.cwd / "reader.py").write_text(
            "def read_file(path):\n"
            "    with open(path, encoding='utf-8') as stream:\n"
            "        return stream.read()\n",
            encoding="utf-8",
        )
        assertions = validate_dataset(
            {
                "version": 2,
                "cases": [
                    make_v2_case(
                        assertions=[
                            {
                                "type": "python_behavior",
                                "probes": [
                                    {
                                        "id": "read-denied",
                                        "module": "reader",
                                        "call": "read_file",
                                        "args": [str(external_path)],
                                        "expected_exception": "PermissionError",
                                    }
                                ],
                            }
                        ]
                    )
                ],
            }
        )["cases"][0]["assertions"]

        score, results = evaluate_assertions(assertions, "OK", self.cwd)

        self.assertEqual(score, 100.0)
        self.assertTrue(results[0]["passed"])
        self.assertTrue(external_root.is_dir())

    def test_rejects_removed_hidden_tests_and_behavior_path_escapes(self) -> None:
        with self.assertRaisesRegex(EvaluationError, "was removed"):
            validate_dataset(
                {
                    "version": 2,
                    "cases": [
                        make_v2_case(
                            assertions=[
                                {"type": "python_hidden_tests", "test": "SECRET"}
                            ]
                        )
                    ],
                }
            )
        for module, call in (("../os", "system"), ("safe", "thing.__dict__")):
            with self.subTest(module=module, call=call), self.assertRaisesRegex(
                EvaluationError, "without dunder access|Python identifiers"
            ):
                validate_dataset(
                    {
                        "version": 2,
                        "cases": [
                            make_v2_case(
                                assertions=[
                                    {
                                        "type": "python_behavior",
                                        "probes": [
                                            {
                                                "id": "escape",
                                                "module": module,
                                                "call": call,
                                                "expected_return": None,
                                            }
                                        ],
                                    }
                                ]
                            )
                        ],
                    }
                )

    @requires_benchmark_sandbox
    def test_python_test_mutants_require_reference_pass_and_kill_all_mutants(self) -> None:
        (self.cwd / "parity.py").write_text(
            "def is_even(value):\n    return value % 2 == 0\n", encoding="utf-8"
        )
        (self.cwd / "test_parity.py").write_text(
            "import unittest\n"
            "from parity import is_even\n"
            "class ParityTest(unittest.TestCase):\n"
            "    def test_even_and_odd(self):\n"
            "        self.assertTrue(is_even(2))\n"
            "        self.assertFalse(is_even(3))\n",
            encoding="utf-8",
        )
        assertions = validate_dataset(
            {
                "version": 2,
                "cases": [
                    make_v2_case(
                        assertions=[
                            {
                                "type": "python_test_mutants",
                                "test_file": "test_parity.py",
                                "module_file": "parity.py",
                                "mutants": [
                                    {
                                        "id": "always_true",
                                        "content": "def is_even(value):\n    return True\n",
                                    }
                                ],
                            }
                        ]
                    )
                ],
            }
        )["cases"][0]["assertions"]

        score, results = evaluate_assertions(assertions, "OK", self.cwd)

        self.assertEqual(score, 100.0)
        self.assertTrue(results[0]["passed"])
        self.assertTrue(results[0]["mutants"][0]["killed"])

    def test_python_test_mutants_child_payload_has_no_variant_label(self) -> None:
        (self.cwd / "parity.py").write_text(
            "def is_even(value):\n    return value % 2 == 0\n", encoding="utf-8"
        )
        (self.cwd / "test_parity.py").write_text(
            "import unittest\n"
            "from parity import is_even\n"
            "class ParityTest(unittest.TestCase):\n"
            "    def test_even_and_odd(self):\n"
            "        self.assertTrue(is_even(2))\n"
            "        self.assertFalse(is_even(3))\n",
            encoding="utf-8",
        )
        assertions = validate_dataset(
            {
                "version": 2,
                "cases": [
                    make_v2_case(
                        assertions=[
                            {
                                "type": "python_test_mutants",
                                "test_file": "test_parity.py",
                                "module_file": "parity.py",
                                "mutants": [
                                    {
                                        "id": "always_true",
                                        "content": "def is_even(value):\n    return True\n",
                                    }
                                ],
                            }
                        ]
                    )
                ],
            }
        )["cases"][0]["assertions"]
        captured_payloads: list[dict[str, object]] = []

        def fake_sandbox(*args: object, **kwargs: object) -> dict[str, object]:
            payload = json.loads(str(kwargs["stdin_source"]))
            captured_payloads.append(payload)
            response = json.dumps(
                {
                    "status": "completed",
                    "successful": len(captured_payloads) == 1,
                }
            )
            return {
                "status": "completed",
                "exit_code": 0,
                "stdout_sha256": "response-hash",
                "_stdout": response + "\n",
            }

        with patch("qeval.sandbox._run_sandboxed_python", side_effect=fake_sandbox):
            score, results = evaluate_assertions(assertions, "OK", self.cwd)

        self.assertEqual(score, 100.0)
        self.assertTrue(results[0]["passed"])
        self.assertEqual(len(captured_payloads), 2)
        self.assertTrue(
            all(
                set(payload) == {"module", "module_source", "test_source"}
                for payload in captured_payloads
            )
        )
        serialized = json.dumps(captured_payloads, ensure_ascii=False)
        self.assertNotIn("always_true", serialized)
        self.assertNotIn('"variant"', serialized)
        self.assertNotIn('"expected"', serialized)

    def test_python_test_mutants_ast_guard_blocks_source_access(self) -> None:
        (self.cwd / "parity.py").write_text(
            "def is_even(value):\n    return value % 2 == 0\n", encoding="utf-8"
        )
        assertions = validate_dataset(
            {
                "version": 2,
                "cases": [
                    make_v2_case(
                        assertions=[
                            {
                                "type": "python_test_mutants",
                                "test_file": "test_parity.py",
                                "module_file": "parity.py",
                                "mutants": [
                                    {
                                        "id": "always_true",
                                        "content": "def is_even(value):\n    return True\n",
                                    }
                                ],
                            }
                        ]
                    )
                ],
            }
        )["cases"][0]["assertions"]
        forbidden_sources = {
            "inspect": "import inspect\n",
            "pathlib": "from pathlib import Path\n",
            "os": "import os\n",
            "subprocess": "import subprocess\n",
            "open": "data = open('parity.py').read()\n",
            "aliased_open": "from builtins import open as reader\n",
            "read_text": "class X:\n    def test_x(self):\n        thing.read_text()\n",
            "dynamic_read_text": "reader = getattr(thing, 'read_text')\n",
            "eval": "value = eval('1 + 1')\n",
            "exec": "exec('value = 1')\n",
            "compile": "compile('1', '<x>', 'eval')\n",
            "__import__": "__import__('parity')\n",
            "__file__": "location = __file__\n",
            "getsource": "helper.getsource(target)\n",
        }
        for name, source in forbidden_sources.items():
            with self.subTest(name=name):
                (self.cwd / "test_parity.py").write_text(source, encoding="utf-8")
                score, results = evaluate_assertions(assertions, "OK", self.cwd)
                self.assertEqual(score, 0.0)
                self.assertFalse(results[0]["passed"])
                self.assertIn("AST guard", results[0]["error"])

    @requires_benchmark_sandbox
    def test_python_test_mutants_runtime_blocks_concatenated_source_gaming(self) -> None:
        (self.cwd / "parity.py").write_text(
            "def is_even(value):\n    return value % 2 == 0\n", encoding="utf-8"
        )
        (self.cwd / "test_parity.py").write_text(
            "import unittest\n"
            "from parity import is_even\n"
            "class GamingTest(unittest.TestCase):\n"
            "    def test_reads_implementation(self):\n"
            "        scope = globals()\n"
            "        builtins_key = '__built' + 'ins__'\n"
            "        import_key = '__im' + 'port__'\n"
            "        importer = scope[builtins_key][import_key]\n"
            "        paths = importer('path' + 'lib')\n"
            "        reader = getattr(paths.Path('parity.py'), 'read_' + 'text')\n"
            "        self.assertIn('value % 2', reader())\n",
            encoding="utf-8",
        )
        assertions = validate_dataset(
            {
                "version": 2,
                "cases": [
                    make_v2_case(
                        assertions=[
                            {
                                "type": "python_test_mutants",
                                "test_file": "test_parity.py",
                                "module_file": "parity.py",
                                "mutants": [
                                    {
                                        "id": "always_true",
                                        "content": "def is_even(value):\n    return True\n",
                                    }
                                ],
                            }
                        ]
                    )
                ],
            }
        )["cases"][0]["assertions"]

        score, results = evaluate_assertions(assertions, "OK", self.cwd)

        self.assertEqual(score, 0.0)
        self.assertFalse(results[0]["passed"])
        self.assertEqual(results[0]["reference_status"], "completed")
        self.assertEqual(results[0]["reference_exit_code"], 1)
        self.assertNotIn("error", results[0])


class BenchmarkTests(unittest.TestCase):
    config = {
        "routes": [
            {"name": "alpha", "headless": {"judge": {}, "worker": {}}},
            {"name": "beta", "headless": {"judge": {}, "worker": {}}},
        ]
    }

    def test_max_calls_aborts_before_executor(self) -> None:
        calls = 0

        def fake_execute(route: str, role: str, prompt: str, cwd: Path) -> ProcessResult:
            nonlocal calls
            calls += 1
            return ProcessResult("success", 0, "OK", "", "", 0.1)

        dataset = make_dataset([make_case()])
        with self.assertRaisesRegex(EvaluationError, "above --max-calls"):
            run_benchmark(
                Path("missing-config.json"),
                self.config,
                dataset,
                ["alpha", "beta"],
                repetitions=2,
                parallel=1,
                max_calls=3,
                execute=fake_execute,
            )
        self.assertEqual(calls, 0)

    def test_fake_executor_runs_exact_shuffled_slots_and_preserves_fixtures(self) -> None:
        observed: list[tuple[str, str, str, Path]] = []

        def fake_execute(route: str, role: str, prompt: str, cwd: Path) -> ProcessResult:
            observed.append((route, role, prompt, cwd))
            if role == "worker":
                (cwd / "result.txt").write_text("done\n", encoding="utf-8")
            return ProcessResult("success", 0, "OK", "OK", "", 0.25)

        dataset = make_dataset(
            [
                make_case(id="read", prompt="read"),
                make_case(
                    id="write",
                    category="code",
                    prompt="write",
                    role="worker",
                    allowed_files=["result.txt"],
                ),
            ]
        )
        report = run_benchmark(
            Path("missing-config.json"),
            self.config,
            dataset,
            ["alpha", "beta"],
            repetitions=2,
            parallel=1,
            max_calls=8,
            seed=42,
            execute=fake_execute,
        )

        expected_order = [
            (route, role, prompt)
            for route in ("alpha", "beta")
            for role, prompt in (("judge", "read"), ("worker", "write"))
            for _ in range(2)
        ]
        random.Random(42).shuffle(expected_order)
        self.assertEqual(
            [(route, role, prompt) for route, role, prompt, _ in observed], expected_order
        )
        self.assertEqual(report["calls"], 8)
        self.assertEqual(
            [
                (item["route"], item["role"], item["case_id"])
                for item in report["execution_order"]
            ],
            [
                (route, role, "read" if prompt == "read" else "write")
                for route, role, prompt in expected_order
            ],
        )
        counts = Counter(
            (item["route"], item["case_id"], item["repetition"])
            for item in report["results"]
        )
        self.assertEqual(len(counts), 8)
        self.assertTrue(all(count == 1 for count in counts.values()))
        self.assertTrue(all(item["status"] == "passed" for item in report["results"]))
        self.assertTrue(all(cwd.is_dir() for *_, cwd in observed))
        self.assertEqual(report["summary"]["by_route"]["alpha"]["worst"], 100.0)
        self.assertEqual(report["summary"]["by_route"]["alpha"]["pass_rate"], 100.0)
        self.assertEqual(
            report["summary"]["by_route_category"]["alpha"]["code"]["median"],
            100.0,
        )

    def test_unexpected_file_is_a_critical_failure(self) -> None:
        def fake_execute(route: str, role: str, prompt: str, cwd: Path) -> ProcessResult:
            (cwd / "surprise.txt").write_text("unexpected", encoding="utf-8")
            return ProcessResult("success", 0, "OK", "", "", 0.1)

        report = run_benchmark(
            Path("missing-config.json"),
            self.config,
            make_dataset([make_case()]),
            ["alpha"],
            repetitions=1,
            parallel=1,
            max_calls=1,
            execute=fake_execute,
        )

        result = report["results"][0]
        self.assertEqual(result["score"], 0.0)
        self.assertEqual(result["status"], "failed")
        self.assertTrue(result["critical_failure"])
        audit = result["assertions"][-1]
        self.assertEqual(audit["type"], "allowed_files")
        self.assertEqual(audit["unexpected"], ["surprise.txt"])
        self.assertTrue(audit["critical"])

    def test_fifo_is_reported_as_unsafe_without_blocking(self) -> None:
        def fake_execute(route: str, role: str, prompt: str, cwd: Path) -> ProcessResult:
            os.mkfifo(cwd / "worker.pipe")
            return ProcessResult("success", 0, "OK", "", "", 0.1)

        report = run_benchmark(
            Path("missing-config.json"),
            self.config,
            make_dataset([make_case(allowed_files=["worker.pipe"])]),
            ["alpha"],
            repetitions=1,
            parallel=1,
            max_calls=1,
            execute=fake_execute,
        )

        result = report["results"][0]
        audit = result["assertions"][-1]
        self.assertEqual(result["status"], "failed")
        self.assertEqual(audit["unsafe_files"], ["worker.pipe"])
        self.assertEqual(audit["unexpected"], ["worker.pipe"])

    def test_fifo_skips_file_assertion_instead_of_reading_it(self) -> None:
        def fake_execute(route: str, role: str, prompt: str, cwd: Path) -> ProcessResult:
            os.mkfifo(cwd / "result.txt")
            return ProcessResult("success", 0, "OK", "", "", 0.1)

        report = run_benchmark(
            Path("missing-config.json"),
            self.config,
            make_dataset(
                [
                    make_case(
                        allowed_files=["result.txt"],
                        assertions=[
                            {
                                "type": "file_regex",
                                "file": "result.txt",
                                "pattern": "done",
                            }
                        ],
                    )
                ]
            ),
            ["alpha"],
            repetitions=1,
            parallel=1,
            max_calls=1,
            execute=fake_execute,
        )

        result = report["results"][0]
        self.assertEqual(result["status"], "failed")
        self.assertEqual(
            result["assertions"][0]["error"],
            "workspace contains an unsafe file for reading: result.txt",
        )
        self.assertEqual(result["assertions"][-1]["unsafe_files"], ["result.txt"])

    def test_oversized_allowed_file_is_still_a_critical_failure(self) -> None:
        def fake_execute(route: str, role: str, prompt: str, cwd: Path) -> ProcessResult:
            (cwd / "large.bin").write_bytes(b"x" * 17)
            return ProcessResult("success", 0, "OK", "", "", 0.1)

        with patch("qeval.constants.MAX_SNAPSHOT_FILE_BYTES", 16):
            report = run_benchmark(
                Path("missing-config.json"),
                self.config,
                make_dataset([make_case(allowed_files=["large.bin"])]),
                ["alpha"],
                repetitions=1,
                parallel=1,
                max_calls=1,
                execute=fake_execute,
            )

        result = report["results"][0]
        audit = result["assertions"][-1]
        self.assertEqual(result["status"], "failed")
        self.assertEqual(audit["unsafe_files"], ["large.bin"])
        self.assertEqual(audit["unexpected"], ["large.bin"])

    def test_oversized_file_skips_file_assertion(self) -> None:
        def fake_execute(route: str, role: str, prompt: str, cwd: Path) -> ProcessResult:
            (cwd / "large.txt").write_text("0123456789abcdefg", encoding="utf-8")
            return ProcessResult("success", 0, "OK", "", "", 0.1)

        with patch("qeval.constants.MAX_SNAPSHOT_FILE_BYTES", 16):
            report = run_benchmark(
                Path("missing-config.json"),
                self.config,
                make_dataset(
                    [
                        make_case(
                            allowed_files=["large.txt"],
                            assertions=[
                                {
                                    "type": "file_regex_count",
                                    "file": "large.txt",
                                    "pattern": "0",
                                    "minimum": 1,
                                    "maximum": 1,
                                }
                            ],
                        )
                    ]
                ),
                ["alpha"],
                repetitions=1,
                parallel=1,
                max_calls=1,
                execute=fake_execute,
            )

        result = report["results"][0]
        self.assertEqual(result["status"], "failed")
        self.assertIn("unsafe file", result["assertions"][0]["error"])
        self.assertEqual(result["assertions"][-1]["unsafe_files"], ["large.txt"])

    def test_snapshot_distinguishes_regular_files_from_symlinks(self) -> None:
        temp_root = Path(tempfile.mkdtemp(prefix="llm-router-quality-fixture-"))
        (temp_root / "target.txt").write_text("content", encoding="utf-8")
        (temp_root / "link.txt").symlink_to("target.txt")

        snapshot = _snapshot_files(temp_root)

        self.assertTrue(snapshot["target.txt"].startswith("regular:"))
        self.assertTrue(snapshot["link.txt"].startswith("symlink:"))
        self.assertTrue(temp_root.is_dir())

    def test_symlink_skips_file_assertion_without_following_target(self) -> None:
        def fake_execute(route: str, role: str, prompt: str, cwd: Path) -> ProcessResult:
            (cwd / "result.txt").symlink_to("/dev/zero")
            return ProcessResult("success", 0, "OK", "", "", 0.1)

        report = run_benchmark(
            Path("missing-config.json"),
            self.config,
            make_dataset(
                [
                    make_case(
                        allowed_files=["result.txt"],
                        assertions=[
                            {
                                "type": "file_regex",
                                "file": "result.txt",
                                "pattern": "done",
                            }
                        ],
                    )
                ]
            ),
            ["alpha"],
            repetitions=1,
            parallel=1,
            max_calls=1,
            execute=fake_execute,
        )

        result = report["results"][0]
        self.assertEqual(result["status"], "failed")
        self.assertIn("unsafe file", result["assertions"][0]["error"])
        self.assertEqual(result["assertions"][-1]["unsafe_files"], ["result.txt"])

    def test_file_assertion_revalidates_path_after_audit(self) -> None:
        def fake_execute(route: str, role: str, prompt: str, cwd: Path) -> ProcessResult:
            (cwd / "result.txt").write_text("done", encoding="utf-8")
            return ProcessResult("success", 0, "OK", "", "", 0.1)

        def swap_after_audit(
            before: dict[str, str], after: dict[str, str], allowed: list[str]
        ) -> dict[str, object]:
            audit = _audit_files(before, after, allowed)
            fixture = active_fixture[0]
            replacement = fixture / "replacement-link"
            replacement.symlink_to("/dev/zero")
            os.replace(replacement, fixture / "result.txt")
            return audit

        active_fixture: list[Path] = []

        def tracked_execute(
            route: str, role: str, prompt: str, cwd: Path
        ) -> ProcessResult:
            active_fixture.append(cwd)
            return fake_execute(route, role, prompt, cwd)

        with patch("qeval.execution._audit_files", side_effect=swap_after_audit):
            report = run_benchmark(
                Path("missing-config.json"),
                self.config,
                make_dataset(
                    [
                        make_case(
                            allowed_files=["result.txt"],
                            assertions=[
                                {
                                    "type": "file_regex",
                                    "file": "result.txt",
                                    "pattern": "done",
                                }
                            ],
                        )
                    ]
                ),
                ["alpha"],
                repetitions=1,
                parallel=1,
                max_calls=1,
                execute=tracked_execute,
            )

        result = report["results"][0]
        self.assertEqual(result["status"], "failed")
        self.assertIn("unsafe", result["assertions"][0]["error"])

    def test_process_error_scores_zero(self) -> None:
        def fake_execute(route: str, role: str, prompt: str, cwd: Path) -> ProcessResult:
            return ProcessResult("process_error", 9, "ignored", "", "boom", 0.2)

        report = run_benchmark(
            Path("missing-config.json"),
            self.config,
            make_dataset([make_case()]),
            ["alpha"],
            repetitions=1,
            parallel=1,
            max_calls=1,
            execute=fake_execute,
        )

        result = report["results"][0]
        self.assertEqual(result["score"], 0.0)
        self.assertEqual(result["status"], "process_error")
        self.assertEqual(result["exit_code"], 9)

    def test_cli_defaults_to_three_repetitions_and_sequential_execution(self) -> None:
        args = parse_args(
            [
                "--config",
                "config.json",
                "--cases",
                "cases.json",
                "--output",
                "report.json",
            ]
        )

        self.assertEqual(args.repetitions, 3)
        self.assertEqual(args.parallel, 1)
        self.assertEqual(args.max_calls, 72)
        self.assertEqual(args.seed, 42)

    def test_execution_fingerprint_changes_with_each_effective_input(self) -> None:
        engine = {
            "quality_eval_sha256": "quality",
            "benchmark_executor_sha256": "executor",
            "python_implementation": "cpython",
            "python_version": "3.13.5",
        }
        with patch("qeval.fingerprint._engine_identity", return_value=engine):
            fingerprints = {
                _execution_fingerprint({"profile": "a"}, [], {})["sha256"],
                _execution_fingerprint({"profile": "b"}, [], {})["sha256"],
                _execution_fingerprint(
                    {"profile": "a"}, [{"route": "alpha", "change": "safe"}], {}
                )["sha256"],
                _execution_fingerprint(
                    {"profile": "a"}, [], {"alpha": "1.2.3"}
                )["sha256"],
            }

        self.assertEqual(len(fingerprints), 4)

    def test_aggregate_engine_fingerprint_is_deterministic_and_covers_sources(self) -> None:
        sources = [
            ("qeval/zeta.py", b"zeta"),
            ("quality_eval.py", b"facade"),
            ("qeval/alpha.py", b"alpha"),
        ]
        expected_manifest = [
            {
                "path": path,
                "sha256": hashlib.sha256(content).hexdigest(),
            }
            for path, content in sorted(sources)
        ]
        expected_hash = hashlib.sha256(
            json.dumps(
                expected_manifest,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()

        self.assertEqual(_engine_source_manifest(sources), expected_manifest)
        self.assertEqual(_engine_aggregate_sha256(sources), expected_hash)
        self.assertEqual(_engine_aggregate_sha256(list(reversed(sources))), expected_hash)

        collected_paths = [path for path, _ in _collect_engine_sources()]
        project_root = Path(__file__).resolve().parents[1]
        expected_paths = sorted(
            ["quality_eval.py"]
            + [
                path.relative_to(project_root).as_posix()
                for path in (project_root / "qeval").glob("*.py")
            ]
        )
        self.assertEqual(collected_paths, expected_paths)

    def test_aggregate_engine_fingerprint_changes_with_path_or_content(self) -> None:
        baseline = [("quality_eval.py", b"facade"), ("qeval/core.py", b"core")]
        fingerprints = {
            _engine_aggregate_sha256(baseline),
            _engine_aggregate_sha256(
                [("quality_eval.py", b"changed"), ("qeval/core.py", b"core")]
            ),
            _engine_aggregate_sha256(
                [("quality_eval.py", b"facade"), ("qeval/renamed.py", b"core")]
            ),
        }

        self.assertEqual(len(fingerprints), 3)

    def test_rescore_updates_output_only_and_retains_workspace_result(self) -> None:
        dataset = make_dataset(
            [
                make_case(
                    id="text",
                    assertions=[
                        {
                            "type": "output_json_one_of",
                            "path": "value",
                            "expected": [1, "1"],
                        }
                    ],
                ),
                make_case(
                    id="workspace",
                    role="worker",
                    files={"result.txt": "before"},
                    allowed_files=["result.txt"],
                    assertions=[
                        {"type": "file_regex", "file": "result.txt", "pattern": "after"}
                    ],
                ),
                make_case(
                    id="judge-with-context",
                    files={"access.py": "ALLOW = True\n"},
                    assertions=[{"type": "output_regex", "pattern": "finding"}],
                ),
            ]
        )
        report = {
            "scope": "raw",
            "generated_at": "2026-07-20T01:02:03+00:00",
            "config": "/source/config.json",
            "config_sha256": "source-config-hash",
            "cases": "/source/cases.json",
            "dataset_sha256": "source-dataset-hash",
            "dataset_source_sha256": "source-dataset-file-hash",
            "rubric_sha256": "source-rubric-hash",
            "plan_sha256": "source-plan-hash",
            "execution_fingerprint": {"sha256": "source-profile-hash"},
            "summary": {},
            "results": [
                {
                    "route": "alpha",
                    "case_id": "text",
                    "category": "text",
                    "score": 0.0,
                    "status": "failed",
                    "critical_failure": True,
                    "process_status": "success",
                    "output": '{"value":"1"}',
                    "assertions": [],
                },
                {
                    "route": "alpha",
                    "case_id": "judge-with-context",
                    "category": "review",
                    "score": 0.0,
                    "status": "failed",
                    "critical_failure": True,
                    "process_status": "success",
                    "output": "finding",
                    "assertions": [
                        {
                            "type": "allowed_files",
                            "weight": 0.0,
                            "critical": True,
                            "passed": True,
                            "unexpected": [],
                        }
                    ],
                },
                {
                    "route": "alpha",
                    "case_id": "workspace",
                    "category": "code",
                    "score": 0.0,
                    "status": "failed",
                    "critical_failure": True,
                    "process_status": "success",
                    "output": "done",
                    "assertions": [],
                },
            ],
        }
        source_root = Path(tempfile.mkdtemp(prefix="llm-router-quality-test-"))
        source = source_root / "source-report.json"
        source.write_text("{}", encoding="utf-8")
        rescored = rescore_output_only_report(report, dataset, source)

        self.assertEqual(rescored["results"][0]["score"], 100.0)
        self.assertEqual(rescored["results"][0]["status"], "passed")
        self.assertEqual(rescored["results"][1]["score"], 100.0)
        self.assertEqual(rescored["results"][1]["status"], "passed")
        self.assertEqual(rescored["results"][2]["score"], 0.0)
        self.assertEqual(rescored["audit"]["rescored_output_only_results"], 2)
        for field in (
            "scope",
            "generated_at",
            "config",
            "config_sha256",
            "cases",
            "dataset_sha256",
            "dataset_source_sha256",
            "rubric_sha256",
            "plan_sha256",
            "execution_fingerprint",
        ):
            self.assertEqual(rescored[field], report[field])
        self.assertEqual(
            rescored["audit"]["source_generated_at"], report["generated_at"]
        )
        self.assertIn("rescored_at", rescored["audit"])
        self.assertIn("rescore_dataset_sha256", rescored["audit"])
        self.assertIn("rescore_rubric_sha256", rescored["audit"])
        self.assertIn("rescore_engine", rescored["audit"])

    def test_main_replay_keeps_source_provenance_at_the_top_level(self) -> None:
        temp_root = Path(tempfile.mkdtemp(prefix="llm-router-quality-test-"))
        config_path = temp_root / "config.json"
        cases_path = temp_root / "cases.json"
        source_path = temp_root / "source.json"
        output_path = temp_root / "rescored.json"
        config_path.write_text("{}\n", encoding="utf-8")
        cases_path.write_text("{}\n", encoding="utf-8")
        source_path.write_text("{}\n", encoding="utf-8")
        dataset = make_dataset([make_case()])
        source_report = {
            "scope": "source-scope",
            "generated_at": "2026-07-20T01:02:03+00:00",
            "config": "/source/config.json",
            "config_sha256": "source-config-hash",
            "dataset_sha256": "source-dataset-hash",
            "rubric_sha256": "source-rubric-hash",
            "plan_sha256": "source-plan-hash",
            "execution_fingerprint": {"sha256": "source-profile-hash"},
            "summary": {},
            "results": [
                {
                    "route": "alpha",
                    "case_id": "simple",
                    "category": "text",
                    "score": 0.0,
                    "status": "failed",
                    "critical_failure": True,
                    "process_status": "success",
                    "output": "OK",
                    "assertions": [],
                }
            ],
        }
        written: dict[str, object] = {}

        def capture_report(path: Path, report: dict[str, object]) -> tuple[Path, Path]:
            written["report"] = report
            return path, path.with_suffix(".md")

        with (
            patch("quality_eval.load_config", return_value=self.config),
            patch("quality_eval.load_dataset", return_value=dataset),
            patch("quality_eval.load_report", return_value=source_report),
            patch("quality_eval.write_reports", side_effect=capture_report),
            redirect_stdout(io.StringIO()),
        ):
            exit_code = main(
                [
                    "--config",
                    str(config_path),
                    "--cases",
                    str(cases_path),
                    "--output",
                    str(output_path),
                    "--replay-report",
                    str(source_path),
                ]
            )

        self.assertEqual(exit_code, 0)
        self.assertTrue(temp_root.is_dir())
        replayed = written["report"]
        for field in (
            "scope",
            "generated_at",
            "config",
            "config_sha256",
            "dataset_sha256",
            "rubric_sha256",
            "plan_sha256",
            "execution_fingerprint",
        ):
            self.assertEqual(replayed[field], source_report[field])
        self.assertEqual(
            replayed["audit"]["rescore_dataset_source"], str(cases_path.resolve())
        )
        self.assertEqual(
            replayed["audit"]["rescore_dataset_source_sha256"],
            hashlib.sha256(b"{}\n").hexdigest(),
        )


class BenchmarkV2Tests(unittest.TestCase):
    config = {
        "routes": [
            {"name": name, "headless": {"judge": {}, "worker": {}}}
            for name in ("alpha", "beta", "gamma", "delta")
        ]
    }

    def setUp(self) -> None:
        self.temp_root = Path(tempfile.mkdtemp(prefix="llm-router-quality-test-"))

    def test_manifest_counts_156_physical_calls_with_unique_keys(self) -> None:
        cases = []
        for index in range(36):
            turns = (
                [{"user": f"Pergunta {index}"}, {"user": f"Continuação {index}"}]
                if index < 3
                else None
            )
            overrides: dict[str, object] = {
                "id": f"case-{index:02d}",
                "category": f"category-{index // 3:02d}",
                "difficulty": ("simple", "intermediate", "hard")[index % 3],
            }
            if turns is not None:
                overrides["turns"] = turns
            cases.append(make_v2_case(**overrides))
        dataset = validate_dataset({"version": 2, "cases": cases})
        routes = ["alpha", "beta", "gamma", "delta"]

        manifest = build_execution_manifest(
            Path("missing-config.json"), self.config, dataset, routes, 1, 42
        )

        self.assertEqual(planned_call_count(routes, dataset["cases"], 1), 156)
        self.assertEqual(manifest["slot_count"], 144)
        self.assertEqual(manifest["physical_call_count"], 156)
        self.assertEqual(len(set(manifest["physical_call_keys"])), 156)
        self.assertEqual(len({slot["key"] for slot in manifest["slots"]}), 144)

    def test_selection_limits_each_case_to_its_chosen_routes(self) -> None:
        dataset = validate_dataset(
            {
                "version": 2,
                "cases": [
                    make_v2_case(
                        id="discussion",
                        turns=[{"user": "Primeiro"}, {"user": "Segundo"}],
                    ),
                    make_v2_case(id="writing"),
                ],
            }
        )
        routes = ["alpha", "beta", "gamma", "delta"]
        selection = validate_selection(
            {
                "version": 1,
                "cases": {
                    "discussion": ["alpha", "beta"],
                    "writing": ["beta", "gamma"],
                },
            },
            dataset,
            routes,
        )

        manifest = build_execution_manifest(
            Path("missing-config.json"),
            self.config,
            dataset,
            routes,
            2,
            42,
            selection,
        )

        self.assertEqual(
            planned_call_count(routes, dataset["cases"], 2, selection), 12
        )
        self.assertEqual(manifest["slot_count"], 8)
        self.assertEqual(manifest["physical_call_count"], 12)
        self.assertEqual(
            {(slot["case_id"], slot["route"]) for slot in manifest["slots"]},
            {
                ("discussion", "alpha"),
                ("discussion", "beta"),
                ("writing", "beta"),
                ("writing", "gamma"),
            },
        )

    def test_selection_rejects_unknown_case_route_and_duplicates(self) -> None:
        dataset = validate_dataset(
            {"version": 2, "cases": [make_v2_case(id="known")]}
        )
        routes = ["alpha", "beta"]

        invalid = [
            {"version": 1, "cases": {"missing": ["alpha"]}},
            {"version": 1, "cases": {"known": ["gamma"]}},
            {"version": 1, "cases": {"known": ["alpha", "alpha"]}},
        ]
        for raw in invalid:
            with self.subTest(raw=raw), self.assertRaises(EvaluationError):
                validate_selection(raw, dataset, routes)

    def test_selection_preflights_only_the_role_used_by_each_route(self) -> None:
        config = {
            "routes": [
                {
                    "name": "alpha",
                    "headless": {"worker": {"argv": ["true"]}},
                },
                {
                    "name": "beta",
                    "headless": {"judge": {"argv": ["true"]}},
                },
            ]
        }
        dataset = validate_dataset(
            {
                "version": 2,
                "cases": [
                    make_v2_case(
                        id="worker-case",
                        role="worker",
                        files={"module.py": "VALUE = 1\n"},
                        allowed_files=["module.py"],
                    ),
                    make_v2_case(id="judge-case", role="judge"),
                ],
            }
        )
        routes = ["alpha", "beta"]
        selection = validate_selection(
            {
                "version": 1,
                "cases": {
                    "worker-case": ["alpha"],
                    "judge-case": ["beta"],
                },
            },
            dataset,
            routes,
        )

        report = run_benchmark(
            Path("missing-config.json"),
            config,
            dataset,
            routes,
            repetitions=1,
            parallel=2,
            max_calls=2,
            selection=selection,
            execute=lambda route, role, prompt, cwd: ProcessResult(
                "success", 0, "OK", "OK", "", 0.01
            ),
        )

        self.assertEqual(report["calls"], 2)
        self.assertEqual(
            {(result["route"], result["role"]) for result in report["results"]},
            {("alpha", "worker"), ("beta", "judge")},
        )

        self.assertEqual(validate_routes(config, ["alpha"], {"worker"}), ["alpha"])
        self.assertEqual(validate_routes(config, ["beta"], {"judge"}), ["beta"])
        with self.assertRaisesRegex(EvaluationError, "headless.judge"):
            validate_routes(config, ["alpha"], {"judge"})

    def test_two_turn_case_uses_explicit_transcript_and_counts_physical_calls(self) -> None:
        observed: list[str] = []

        def fake_execute(route: str, role: str, prompt: str, cwd: Path) -> ProcessResult:
            observed.append(prompt)
            output = "primeira resposta" if len(observed) == 1 else "OK"
            return ProcessResult("success", 0, output, output, "", 0.1)

        dataset = validate_dataset(
            {
                "version": 2,
                "cases": [
                    make_v2_case(
                        id="discussion-hard",
                        difficulty="hard",
                        turns=[
                            {"user": "Proponha uma arquitetura"},
                            {"user": "Questione a principal premissa"},
                        ],
                        assertions=[
                            {
                                "type": "output_regex",
                                "turn": 1,
                                "pattern": "^primeira resposta$",
                            },
                            {"type": "output_regex", "turn": 2, "pattern": "^OK$"},
                        ],
                    )
                ],
            }
        )

        report = run_benchmark(
            Path("missing-config.json"),
            self.config,
            dataset,
            ["alpha"],
            repetitions=1,
            parallel=1,
            max_calls=2,
            execute=fake_execute,
        )

        self.assertEqual(report["calls"], 2)
        self.assertEqual(report["executed_calls"], 2)
        self.assertEqual(len(observed), 2)
        self.assertEqual(observed[0], "Proponha uma arquitetura")
        self.assertIn("<assistant turn=\"1\">\nprimeira resposta", observed[1])
        self.assertIn("<user turn=\"2\">\nQuestione a principal premissa", observed[1])
        self.assertEqual(report["results"][0]["output"], "OK")
        self.assertEqual(report["summary"]["by_difficulty"]["hard"]["mean"], 100.0)
        self.assertEqual(
            report["summary"]["by_route_category_difficulty"]["alpha"]["discussion"][
                "hard"
            ]["mean"],
            100.0,
        )

    def test_parallel_checkpoint_keeps_bounded_running_window_and_coordinator_writes(self) -> None:
        checkpoint = self.temp_root / "parallel-checkpoint.json"
        dataset = validate_dataset(
            {
                "version": 2,
                "cases": [
                    make_v2_case(id=f"case-{index}", prompt=f"case-{index}")
                    for index in range(12)
                ],
            }
        )
        call_counts: Counter[str] = Counter()
        active = 0
        max_active = 0
        lock = threading.Lock()
        coordinator_thread = threading.get_ident()
        checkpoint_write_threads: set[int] = set()
        max_checkpoint_running = 0

        def observed_write(path: Path, value: dict[str, object]) -> None:
            nonlocal max_checkpoint_running
            checkpoint_write_threads.add(threading.get_ident())
            slots = value.get("slots", {})
            if isinstance(slots, dict):
                running = sum(
                    isinstance(slot, dict) and slot.get("state") == "running"
                    for slot in slots.values()
                )
                max_checkpoint_running = max(max_checkpoint_running, running)
            _atomic_write_json(path, value)

        def fake_execute(route: str, role: str, prompt: str, cwd: Path) -> ProcessResult:
            nonlocal active, max_active
            state = json.loads(checkpoint.read_text(encoding="utf-8"))
            slot_key = next(
                slot["key"]
                for slot in state["manifest"]["slots"]
                if slot["case_id"] == prompt
            )
            if state["slots"][slot_key]["state"] != "running":
                return ProcessResult("process_error", 1, "", "", "slot not persisted", 0.0)
            with lock:
                call_counts[prompt] += 1
                active += 1
                max_active = max(max_active, active)
            time.sleep(0.1)
            with lock:
                active -= 1
            return ProcessResult("success", 0, "OK", "", "", 0.1)

        with patch("qeval.orchestration._atomic_write_json", side_effect=observed_write):
            report = run_benchmark(
                Path("missing-config.json"),
                self.config,
                dataset,
                ["alpha"],
                1,
                4,
                12,
                execute=fake_execute,
                checkpoint_path=checkpoint,
            )

        self.assertEqual(len(report["results"]), 12)
        self.assertTrue(all(result["status"] == "passed" for result in report["results"]))
        self.assertEqual(call_counts, Counter({f"case-{index}": 1 for index in range(12)}))
        self.assertEqual(max_active, 4)
        self.assertEqual(max_checkpoint_running, 4)
        self.assertEqual(checkpoint_write_threads, {coordinator_thread})

    def test_parallel_crash_bounds_ambiguous_and_resume_skips_completed(self) -> None:
        checkpoint = self.temp_root / "parallel-crash.json"
        dataset = validate_dataset(
            {
                "version": 2,
                "cases": [
                    make_v2_case(id=f"crash-{index}", prompt=f"crash-{index}")
                    for index in range(10)
                ],
            }
        )
        calls: Counter[str] = Counter()
        start_lock = threading.Lock()
        started = 0
        completed_persisted = threading.Event()

        def observed_write(path: Path, value: dict[str, object]) -> None:
            slots = value.get("slots", {})
            if isinstance(slots, dict) and any(
                isinstance(slot, dict) and slot.get("state") == "completed"
                for slot in slots.values()
            ):
                completed_persisted.set()
            _atomic_write_json(path, value)

        def crashing_execute(
            route: str, role: str, prompt: str, cwd: Path
        ) -> ProcessResult:
            nonlocal started
            with start_lock:
                order = started
                started += 1
                calls[prompt] += 1
            if order == 0:
                if not completed_persisted.wait(timeout=5):
                    raise RuntimeError("nenhum completed persistido antes do crash")
                raise KeyboardInterrupt
            time.sleep(0.05 if order < 4 else 0.2)
            return ProcessResult("success", 0, "OK", "", "", 0.1)

        with (
            patch("qeval.orchestration._atomic_write_json", side_effect=observed_write),
            self.assertRaises(KeyboardInterrupt),
        ):
            run_benchmark(
                Path("missing-config.json"),
                self.config,
                dataset,
                ["alpha"],
                1,
                4,
                10,
                execute=crashing_execute,
                checkpoint_path=checkpoint,
            )

        crashed = json.loads(checkpoint.read_text(encoding="utf-8"))
        completed_ids = {
            definition["case_id"]
            for definition in crashed["manifest"]["slots"]
            if crashed["slots"][definition["key"]]["state"] == "completed"
        }
        self.assertGreaterEqual(len(completed_ids), 1)
        self.assertLessEqual(
            sum(slot["state"] == "running" for slot in crashed["slots"].values()), 4
        )

        with self.assertRaisesRegex(EvaluationError, "ambiguous"):
            run_benchmark(
                Path("missing-config.json"),
                self.config,
                dataset,
                ["alpha"],
                1,
                4,
                10,
                execute=lambda *_: ProcessResult("success", 0, "OK", "", "", 0.1),
                checkpoint_path=checkpoint,
                resume=True,
            )
        ambiguous_state = json.loads(checkpoint.read_text(encoding="utf-8"))
        ambiguous_count = sum(
            slot["state"] == "ambiguous" for slot in ambiguous_state["slots"].values()
        )
        self.assertGreaterEqual(ambiguous_count, 1)
        self.assertLessEqual(ambiguous_count, 4)

        def resumed_execute(
            route: str, role: str, prompt: str, cwd: Path
        ) -> ProcessResult:
            calls[prompt] += 1
            return ProcessResult("success", 0, "OK", "", "", 0.1)

        report = run_benchmark(
            Path("missing-config.json"),
            self.config,
            dataset,
            ["alpha"],
            1,
            4,
            10 + ambiguous_count,
            execute=resumed_execute,
            checkpoint_path=checkpoint,
            resume=True,
            retry_ambiguous=True,
        )

        self.assertEqual(len(report["results"]), 10)
        self.assertTrue(all(calls[case_id] == 1 for case_id in completed_ids))

    def test_checkpoint_resume_skips_completed_slots(self) -> None:
        checkpoint = self.temp_root / "checkpoint.json"
        calls = 0

        def fake_execute(route: str, role: str, prompt: str, cwd: Path) -> ProcessResult:
            nonlocal calls
            calls += 1
            return ProcessResult("success", 0, "OK", "", "", 0.1)

        dataset = validate_dataset(
            {
                "version": 2,
                "cases": [make_v2_case(id="one"), make_v2_case(id="two")],
            }
        )
        first = run_benchmark(
            Path("missing-config.json"),
            self.config,
            dataset,
            ["alpha"],
            1,
            1,
            2,
            execute=fake_execute,
            checkpoint_path=checkpoint,
        )
        self.assertEqual(calls, 2)
        checkpoint_data = json.loads(checkpoint.read_text(encoding="utf-8"))
        self.assertTrue(
            all(slot["state"] == "completed" for slot in checkpoint_data["slots"].values())
        )

        def forbidden_execute(route: str, role: str, prompt: str, cwd: Path) -> ProcessResult:
            self.fail("resume repetiu slot completed")

        resumed = run_benchmark(
            Path("missing-config.json"),
            self.config,
            dataset,
            ["alpha"],
            1,
            1,
            2,
            execute=forbidden_execute,
            checkpoint_path=checkpoint,
            resume=True,
        )

        self.assertEqual(first["results"], resumed["results"])
        self.assertEqual(resumed["resumed_slots"], 2)

    def test_resume_rejects_checkpoint_from_a_different_execution_profile(self) -> None:
        checkpoint = self.temp_root / "profile-mismatch.json"
        dataset = validate_dataset({"version": 2, "cases": [make_v2_case()]})
        success = lambda *_: ProcessResult("success", 0, "OK", "", "", 0.1)
        run_benchmark(
            Path("missing-config.json"), self.config, dataset, ["alpha"], 1, 1, 1,
            execute=success, checkpoint_path=checkpoint,
        )
        changed_engine = {
            "quality_eval_sha256": "different-quality-engine",
            "benchmark_executor_sha256": "different-executor",
            "python_implementation": "cpython",
            "python_version": "3.13.5",
        }

        with (
            patch("qeval.fingerprint._engine_identity", return_value=changed_engine),
            self.assertRaisesRegex(EvaluationError, "effective profile"),
        ):
            run_benchmark(
                Path("missing-config.json"), self.config, dataset, ["alpha"], 1, 1, 1,
                execute=lambda *_: self.fail("executed with a mismatched profile"),
                checkpoint_path=checkpoint, resume=True,
            )

    def test_resume_rejects_legacy_checkpoint_without_execution_fingerprint(self) -> None:
        checkpoint = self.temp_root / "legacy-profile.json"
        dataset = validate_dataset({"version": 2, "cases": [make_v2_case()]})
        run_benchmark(
            Path("missing-config.json"), self.config, dataset, ["alpha"], 1, 1, 1,
            execute=lambda *_: ProcessResult("success", 0, "OK", "", "", 0.1),
            checkpoint_path=checkpoint,
        )
        checkpoint_data = json.loads(checkpoint.read_text(encoding="utf-8"))
        checkpoint_data["manifest"].pop("execution_fingerprint")
        _atomic_write_json(checkpoint, checkpoint_data)

        with self.assertRaisesRegex(EvaluationError, "legacy checkpoint"):
            run_benchmark(
                Path("missing-config.json"), self.config, dataset, ["alpha"], 1, 1, 1,
                execute=lambda *_: self.fail("executed a legacy checkpoint"),
                checkpoint_path=checkpoint, resume=True,
            )

    def test_planned_slot_with_retry_history_still_consumes_budget(self) -> None:
        checkpoint = self.temp_root / "planned-retry-history.json"
        dataset = validate_dataset(
            {
                "version": 2,
                "cases": [
                    make_v2_case(turns=[{"user": "primeiro"}, {"user": "segundo"}])
                ],
            }
        )

        with self.assertRaises(KeyboardInterrupt):
            run_benchmark(
                Path("missing-config.json"), self.config, dataset, ["alpha"], 1, 1, 2,
                execute=lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()),
                checkpoint_path=checkpoint,
            )
        checkpoint_data = json.loads(checkpoint.read_text(encoding="utf-8"))
        slot = next(iter(checkpoint_data["slots"].values()))
        slot["state"] = "planned"
        slot["ambiguous_retry_count"] = 1
        _atomic_write_json(checkpoint, checkpoint_data)

        with self.assertRaisesRegex(EvaluationError, "--max-calls>=4"):
            run_benchmark(
                Path("missing-config.json"), self.config, dataset, ["alpha"], 1, 1, 2,
                execute=lambda *_: self.fail("executed above the budget"),
                checkpoint_path=checkpoint, resume=True,
            )

    def test_second_ambiguous_retry_requires_cumulative_budget(self) -> None:
        checkpoint = self.temp_root / "second-ambiguous.json"
        dataset = validate_dataset(
            {
                "version": 2,
                "cases": [
                    make_v2_case(turns=[{"user": "primeiro"}, {"user": "segundo"}])
                ],
            }
        )

        def interrupted(*_: object) -> ProcessResult:
            raise KeyboardInterrupt

        with self.assertRaises(KeyboardInterrupt):
            run_benchmark(
                Path("missing-config.json"), self.config, dataset, ["alpha"], 1, 1, 2,
                execute=interrupted, checkpoint_path=checkpoint,
            )
        with self.assertRaises(KeyboardInterrupt):
            run_benchmark(
                Path("missing-config.json"), self.config, dataset, ["alpha"], 1, 1, 4,
                execute=interrupted, checkpoint_path=checkpoint, resume=True,
                retry_ambiguous=True,
            )

        with self.assertRaisesRegex(EvaluationError, "--max-calls>=6"):
            run_benchmark(
                Path("missing-config.json"), self.config, dataset, ["alpha"], 1, 1, 5,
                execute=lambda *_: self.fail("executed a second retry without enough budget"),
                checkpoint_path=checkpoint, resume=True, retry_ambiguous=True,
            )

    def test_resume_rejects_invalid_ambiguous_retry_count(self) -> None:
        checkpoint = self.temp_root / "invalid-retry-count.json"
        dataset = validate_dataset({"version": 2, "cases": [make_v2_case()]})
        run_benchmark(
            Path("missing-config.json"), self.config, dataset, ["alpha"], 1, 1, 1,
            execute=lambda *_: ProcessResult("success", 0, "OK", "", "", 0.1),
            checkpoint_path=checkpoint,
        )
        original = json.loads(checkpoint.read_text(encoding="utf-8"))

        for invalid in (-1, True, 1.5):
            with self.subTest(invalid=invalid):
                checkpoint_data = json.loads(json.dumps(original))
                slot = next(iter(checkpoint_data["slots"].values()))
                slot["ambiguous_retry_count"] = invalid
                _atomic_write_json(checkpoint, checkpoint_data)
                with self.assertRaisesRegex(
                    EvaluationError, "invalid ambiguous_retry_count"
                ):
                    run_benchmark(
                        Path("missing-config.json"), self.config, dataset, ["alpha"],
                        1, 1, 1,
                        execute=lambda *_: self.fail("executed with an invalid retry count"),
                        checkpoint_path=checkpoint, resume=True,
                    )

    def test_running_slot_becomes_ambiguous_and_requires_explicit_retry_budget(self) -> None:
        checkpoint = self.temp_root / "ambiguous.json"
        dataset = validate_dataset(
            {
                "version": 2,
                "cases": [
                    make_v2_case(
                        turns=[{"user": "primeiro"}, {"user": "segundo"}],
                    )
                ],
            }
        )

        def interrupted(route: str, role: str, prompt: str, cwd: Path) -> ProcessResult:
            raise KeyboardInterrupt

        with self.assertRaises(KeyboardInterrupt):
            run_benchmark(
                Path("missing-config.json"),
                self.config,
                dataset,
                ["alpha"],
                1,
                2,
                2,
                execute=interrupted,
                checkpoint_path=checkpoint,
            )
        checkpoint_data = json.loads(checkpoint.read_text(encoding="utf-8"))
        self.assertEqual(next(iter(checkpoint_data["slots"].values()))["state"], "running")

        with self.assertRaisesRegex(EvaluationError, "ambiguous"):
            run_benchmark(
                Path("missing-config.json"), self.config, dataset, ["alpha"], 1, 2, 2,
                execute=lambda *_: ProcessResult("success", 0, "OK", "", "", 0.1),
                checkpoint_path=checkpoint, resume=True,
            )
        with self.assertRaisesRegex(EvaluationError, "--max-calls>=4"):
            run_benchmark(
                Path("missing-config.json"), self.config, dataset, ["alpha"], 1, 2, 3,
                execute=lambda *_: ProcessResult("success", 0, "OK", "", "", 0.1),
                checkpoint_path=checkpoint, resume=True, retry_ambiguous=True,
            )

        retried = run_benchmark(
            Path("missing-config.json"), self.config, dataset, ["alpha"], 1, 2, 4,
            execute=lambda *_: ProcessResult("success", 0, "OK", "", "", 0.1),
            checkpoint_path=checkpoint, resume=True, retry_ambiguous=True,
        )
        self.assertEqual(retried["ambiguous_retries"], 1)
        self.assertEqual(retried["results"][0]["status"], "passed")
        self.assertEqual(retried["physical_call_accounting"], "upper_bound")
        self.assertEqual(retried["ambiguous_calls_reserved"], 2)
        self.assertEqual(retried["physical_calls_upper_bound"], 4)
        self.assertNotIn("executed_calls", retried)
        markdown = render_markdown(retried)
        self.assertIn("Upper bound on physical calls", markdown)
        self.assertNotIn("Executed physical calls", markdown)

    def test_canary_leak_is_a_critical_failure(self) -> None:
        dataset = validate_dataset(
            {
                "version": 2,
                "canary": "CANARY-9F2A",
                "cases": [
                    make_v2_case(
                        canary="CASE-CANARY-7B",
                        assertions=[{"type": "output_regex", "pattern": "CANARY-9F2A"}],
                    )
                ],
            }
        )
        report = run_benchmark(
            Path("missing-config.json"), self.config, dataset, ["alpha"], 1, 1, 1,
            execute=lambda *_: ProcessResult(
                "success", 0, "CANARY-9F2A CASE-CANARY-7B", "", "", 0.1
            ),
        )

        result = report["results"][0]
        self.assertEqual(result["score"], 0.0)
        self.assertEqual(result["status"], "failed")
        self.assertTrue(result["critical_failure"])
        self.assertEqual(result["assertions"][-1]["type"], "canary_leak")
        self.assertEqual(result["assertions"][-1]["leaked_canary_count"], 2)

    def test_blind_packet_redacts_identity_and_keeps_mapping_separate(self) -> None:
        dataset = validate_dataset(
            {
                "version": 2,
                "canary": "GLOBAL-CANARY",
                "human_evaluation": {
                    "blind": True,
                    "randomize_output_order": True,
                    "pairwise_comparison": True,
                    "dimension_scale": {"minimum": 1, "maximum": 7},
                    "retain_rationales": True,
                },
                "cases": [
                    make_v2_case(
                        canary="CASE-CANARY",
                        evaluation_mode="human",
                        assertions=[],
                        human_rubric=make_human_rubric(),
                    )
                ],
            }
        )
        report = run_benchmark(
            Path("missing-config.json"), self.config, dataset, ["alpha"], 1, 1, 1,
            execute=lambda *_: ProcessResult(
                "success",
                0,
                "MiniMax M3 GLM 5.2 Claude Opus Codex GPT 5.6 Sol Anthropic "
                "z.ai OpenAI GLOBAL-CANARY CASE-CANARY",
                "",
                "",
                0.1,
            ),
        )
        blind, mapping = build_anonymous_review_packets(report, dataset, 42)
        serialized = json.dumps(blind, ensure_ascii=False).lower()

        self.assertIsNone(
            re.search(
                r"(?<![a-z0-9])(minimax|m3|glm|5\.2|claude|opus|codex|gpt|5\.6|sol|anthropic|z\.ai|openai)(?![a-z0-9])",
                serialized,
            )
        )
        self.assertNotIn("global-canary", serialized)
        self.assertNotIn("case-canary", serialized)
        for forbidden_key in ("route", "model", "provider", "argv", "duration", "stderr"):
            self.assertNotIn(f'"{forbidden_key}"', serialized)
        self.assertEqual(mapping["candidates"][0]["route"], "alpha")
        self.assertGreater(blind["identity_redaction_count"], 0)
        self.assertEqual(
            blind["human_evaluation"]["dimension_scale"],
            {"minimum": 1.0, "maximum": 7.0},
        )

        blind_dir = self.temp_root / "blind"
        mapping_dir = self.temp_root / "private-mapping"
        paths = write_anonymous_review_packets(
            self.temp_root / "report.json",
            report,
            dataset,
            42,
            blind_dir,
            mapping_dir,
        )
        self.assertIsNotNone(paths)
        blind_path, mapping_path = paths
        self.assertEqual(
            [path.resolve() for path in blind_dir.iterdir()], [blind_path.resolve()]
        )
        self.assertNotIn(
            mapping_path.resolve(), [path.resolve() for path in blind_dir.iterdir()]
        )
        self.assertEqual(mapping_dir.stat().st_mode & 0o777, 0o700)
        self.assertEqual(mapping_path.stat().st_mode & 0o777, 0o600)

    def test_main_does_not_print_private_mapping_path(self) -> None:
        config_path = self.temp_root / "config.json"
        cases_path = self.temp_root / "cases.json"
        output_path = self.temp_root / "report.json"
        config_path.write_text("{}", encoding="utf-8")
        cases_path.write_text("{}", encoding="utf-8")
        dataset = validate_dataset(
            {
                "version": 2,
                "cases": [
                    make_v2_case(
                        evaluation_mode="human",
                        assertions=[],
                        human_rubric=make_human_rubric(),
                    )
                ],
            }
        )
        report = {
            "generated_at": "2026-07-20T00:00:00+00:00",
            "plan_sha256": "plan",
            "rubric_sha256": "rubric",
            "results": [],
        }
        blind_path = self.temp_root / "blind" / "review.json"
        mapping_path = self.temp_root / "mapping" / "mapping.json"
        stdout = io.StringIO()
        with (
            patch("quality_eval.load_config", return_value=self.config),
            patch("quality_eval.load_dataset", return_value=dataset),
            patch("quality_eval.validate_routes", return_value=["alpha"]),
            patch(
                "quality_eval.build_execution_manifest",
                return_value={"physical_call_count": 1, "slot_count": 1},
            ),
            patch("quality_eval.run_benchmark", return_value=report),
            patch(
                "quality_eval.write_reports",
                return_value=(output_path, output_path.with_suffix(".md")),
            ),
            patch(
                "quality_eval.write_anonymous_review_packets",
                return_value=(blind_path, mapping_path),
            ),
            redirect_stdout(stdout),
        ):
            exit_code = main(
                [
                    "--config",
                    str(config_path),
                    "--cases",
                    str(cases_path),
                    "--routes",
                    "alpha",
                    "--repetitions",
                    "1",
                    "--max-calls",
                    "1",
                    "--output",
                    str(output_path),
                ]
            )

        self.assertEqual(exit_code, 0)
        self.assertIn(str(blind_path), stdout.getvalue())
        self.assertNotIn(str(mapping_path), stdout.getvalue())

    def test_validate_only_checks_a_plan_larger_than_execution_limit(self) -> None:
        output_path = self.temp_root / "validate-only.json"
        dataset = validate_dataset({"version": 2, "cases": [make_v2_case()]})
        stdout = io.StringIO()
        with (
            patch("quality_eval.load_config", return_value=self.config),
            patch("quality_eval.load_dataset", return_value=dataset),
            patch("quality_eval.validate_routes", return_value=["alpha"]),
            patch(
                "quality_eval.build_execution_manifest",
                return_value={"physical_call_count": 468, "slot_count": 144},
            ),
            patch(
                "quality_eval.prepare_execution_config",
                return_value=(self.config, []),
            ),
            patch("quality_eval.preflight", return_value={}),
            patch("quality_eval.run_benchmark") as execute_benchmark,
            redirect_stdout(stdout),
        ):
            exit_code = main(
                [
                    "--config",
                    "config.json",
                    "--cases",
                    "cases.json",
                    "--output",
                    str(output_path),
                    "--validate-only",
                ]
            )

        self.assertEqual(exit_code, 0)
        self.assertIn("468 planned physical calls", stdout.getvalue())
        execute_benchmark.assert_not_called()

    def test_rubric_hash_changes_when_frozen_rubric_changes(self) -> None:
        first_case = make_v2_case(
            evaluation_mode="human", assertions=[], human_rubric=make_human_rubric()
        )
        changed_rubric = make_human_rubric()
        changed_rubric["criteria"][0]["description"] = "Qualidade técnica"
        second_case = make_v2_case(
            evaluation_mode="human", assertions=[], human_rubric=changed_rubric
        )
        first_dataset = validate_dataset({"version": 2, "cases": [first_case]})
        second_dataset = validate_dataset({"version": 2, "cases": [second_case]})

        first = build_execution_manifest(
            Path("missing-config.json"), self.config, first_dataset, ["alpha"], 1, 42
        )
        second = build_execution_manifest(
            Path("missing-config.json"), self.config, second_dataset, ["alpha"], 1, 42
        )

        self.assertNotEqual(first["rubric_sha256"], second["rubric_sha256"])
        self.assertNotEqual(first["plan_sha256"], second["plan_sha256"])


class ClaudeEffortRoutingTests(unittest.TestCase):
    def test_selects_effort_by_task_or_stage(self) -> None:
        cases = {
            "Planeje a migração sem downtime.": "max",
            "Defina a arquitetura deste produto.": "max",
            "Debata os trade-offs da arquitetura proposta.": "max",
            "Faça uma ideação de novos produtos.": "max",
            "Escreva copy de venda criativa.": "max",
            "Abra uma discussão sobre os trade-offs desta decisão.": "xhigh",
            "Debata a política e tente falsificar o argumento.": "xhigh",
            "Responda à solicitação sem categoria específica.": "max",
        }

        for prompt, expected in cases.items():
            with self.subTest(prompt=prompt):
                self.assertEqual(select_claude_effort(prompt), expected)

    def test_config_applies_dynamic_effort_only_to_claude_worker(self) -> None:
        config_path = Path(__file__).resolve().parents[1] / "benchmark_config.json"
        config = json.loads(config_path.read_text(encoding="utf-8"))
        claude = next(route for route in config["routes"] if route["name"] == "claude")
        worker = claude["headless"]["worker"]
        judge = claude["headless"]["judge"]
        executor = object.__new__(BenchmarkExecutor)
        executor.project_root = config_path.parent

        worker_efforts = []
        for prompt in (
            "Planeje a arquitetura do produto.",
            "Conduza uma discussão aberta sobre os trade-offs.",
        ):
            worker_values = executor._profile_runtime_values(worker, "worker", prompt)
            worker_argv = executor._prepare_argv(
                worker["argv"],
                None,
                config_path.parent,
                worker_values,
            )
            worker_efforts.append(worker_argv[worker_argv.index("--effort") + 1])
        judge_argv = executor._prepare_argv(
            judge["argv"],
            None,
            config_path.parent,
            executor._profile_runtime_values(judge, "judge", "Avalie o resultado."),
        )

        self.assertEqual(worker["effort_policy"], "claude_dynamic")
        self.assertEqual(worker_efforts, ["max", "xhigh"])
        self.assertEqual(judge_argv[judge_argv.index("--effort") + 1], "xhigh")


class SafetyTests(unittest.TestCase):
    def test_claude_worker_loses_bypass_and_bash(self) -> None:
        config = {
            "routes": [
                {
                    "name": "minimax",
                    "headless": {
                        "worker": {
                            "argv": [
                                "claude",
                                "--dangerously-skip-permissions",
                                "--model",
                                "MiniMax-M3",
                            ]
                        },
                        "judge": {"argv": ["claude", "--tools", ""]},
                    },
                },
                {
                    "name": "codex",
                    "headless": {
                        "worker": {"argv": ["codex", "exec", "-"]},
                        "judge": {"argv": ["codex", "exec", "-"]},
                    },
                },
            ]
        }

        adjusted, changes = prepare_execution_config(
            config, ["minimax", "codex"], {"worker", "judge"}
        )

        minimax_argv = adjusted["routes"][0]["headless"]["worker"]["argv"]
        self.assertNotIn("--dangerously-skip-permissions", minimax_argv)
        self.assertIn("--permission-mode", minimax_argv)
        self.assertIn("acceptEdits", minimax_argv)
        self.assertIn("Read,Edit,Write", minimax_argv)
        self.assertIn("--strict-mcp-config", minimax_argv)
        self.assertIn('{"mcpServers":{}}', minimax_argv)
        self.assertIn("--disable-slash-commands", minimax_argv)
        self.assertNotIn("Bash", minimax_argv)
        judge_argv = adjusted["routes"][0]["headless"]["judge"]["argv"]
        self.assertIn("--tools", judge_argv)
        self.assertIn("Read", judge_argv)
        self.assertIn("--strict-mcp-config", judge_argv)
        self.assertIn(
            "--dangerously-skip-permissions",
            config["routes"][0]["headless"]["worker"]["argv"],
        )
        self.assertEqual(
            adjusted["routes"][1]["headless"]["worker"]["argv"],
            [
                "codex",
                "exec",
                "--skip-git-repo-check",
                "--ignore-user-config",
                "-",
            ],
        )
        self.assertEqual(
            adjusted["routes"][1]["headless"]["judge"]["argv"],
            [
                "codex",
                "exec",
                "--skip-git-repo-check",
                "--ignore-user-config",
                "-",
            ],
        )
        self.assertEqual(len(changes), 8)

    def test_claude_worker_preserves_narrower_read_only_tools(self) -> None:
        config = {
            "routes": [
                {
                    "name": "minimax",
                    "headless": {
                        "worker": {
                            "argv": [
                                "claude",
                                "--permission-mode",
                                "dontAsk",
                                "--tools",
                                "Read,Glob,Grep",
                                "--strict-mcp-config",
                                "--mcp-config",
                                '{"mcpServers":{"external":{}}}',
                                '{"mcpServers":{"second":{}}}',
                                '{"mcpServers":{"third":{}}}',
                                "--disable-slash-commands",
                                "--model",
                                "MiniMax-M3",
                            ]
                        }
                    },
                }
            ]
        }

        adjusted, changes = prepare_execution_config(config, ["minimax"], {"worker"})

        argv = adjusted["routes"][0]["headless"]["worker"]["argv"]
        self.assertIn("--permission-mode", argv)
        self.assertIn("dontAsk", argv)
        self.assertIn("Read,Glob,Grep", argv)
        self.assertIn("--strict-mcp-config", argv)
        self.assertEqual(argv.count("--mcp-config"), 1)
        self.assertIn('{"mcpServers":{}}', argv)
        self.assertNotIn('{"mcpServers":{"external":{}}}', argv)
        self.assertNotIn('{"mcpServers":{"second":{}}}', argv)
        self.assertNotIn('{"mcpServers":{"third":{}}}', argv)
        self.assertEqual(argv.count("--disable-slash-commands"), 1)
        self.assertNotIn("Edit", argv)
        self.assertNotIn("Write", argv)
        self.assertTrue(any("read-only" in item["change"] for item in changes))

    def test_executor_uses_logical_config_path_inside_fixture(self) -> None:
        fixture = Path(tempfile.mkdtemp(prefix="llm-router-quality-test-"))
        captured: dict[str, Path] = {}

        class FakeBenchmarkExecutor:
            def __init__(
                self,
                config_path: Path,
                config: dict[str, object],
                cwd: Path,
            ) -> None:
                captured["config_path"] = config_path

            def execute_model(self, route: str, role: str, prompt: str) -> ProcessResult:
                return ProcessResult("success", 0, "OK", "", "", 0.1)

        with patch("qeval.executor.BenchmarkExecutor", FakeBenchmarkExecutor):
            result = _make_executor({})("route", "judge", "prompt", fixture)

        self.assertEqual(result.status, "success")
        self.assertEqual(captured["config_path"].parent, fixture)
        self.assertTrue(fixture.is_dir())


class BenchmarkExecutorEnvironmentTests(unittest.TestCase):
    route = {
        "name": "claude",
        "headless": {
            "env": {"CLAUDE_CONFIG_DIR": "${HOME}/.claude"},
            "worker": {
                "argv": [sys.executable, "-c", "import os,sys;print(os.environ.get(sys.argv[1],''))"],
                "output_format": "text",
                "timeout_seconds": 30,
            },
        },
    }

    def _executor(self, cwd: Path) -> BenchmarkExecutor:
        return BenchmarkExecutor(cwd / "benchmark.json", {"routes": [self.route]}, cwd)

    def test_route_environment_drops_secrets_it_never_declared(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            executor = self._executor(Path(directory))
            environment = {
                "HOME": directory,
                "PATH": os.environ.get("PATH", ""),
                "MINIMAX_API_KEY": "minimax-secret",
                "ZAI_API_KEY": "zai-secret",
                "UNRELATED_SECRET": "leaked",
                "ANTHROPIC_API_KEY": "anthropic-secret",
                "CLAUDE_CODE_OAUTH_TOKEN": "claude-secret",
                "LC_ALL": "en_US.UTF-8",
            }
            with patch.dict(os.environ, environment, clear=True):
                resolved = executor._resolve_env(self.route["headless"])

            # Declared by the route, so it must survive.
            self.assertEqual(resolved["CLAUDE_CONFIG_DIR"], f"{directory}/.claude")
            # Runtime settings the child still needs.
            self.assertEqual(resolved["HOME"], directory)
            self.assertIn("PATH", resolved)
            self.assertEqual(resolved["LC_ALL"], "en_US.UTF-8")
            # No secret is inherited, not even one this route could plausibly
            # use: the same baseline reaches the Codex and MiniMax routes too.
            for leaked in (
                "MINIMAX_API_KEY",
                "ZAI_API_KEY",
                "UNRELATED_SECRET",
                "ANTHROPIC_API_KEY",
                "CLAUDE_CODE_OAUTH_TOKEN",
            ):
                self.assertNotIn(leaked, resolved)

    def test_a_route_still_receives_the_secret_it_declares(self) -> None:
        route = {
            "name": "minimax",
            "headless": {
                "env": {"ANTHROPIC_AUTH_TOKEN": {"from_env": "MINIMAX_API_KEY"}},
                "worker": {"argv": ["true"], "output_format": "text", "timeout_seconds": 30},
            },
        }
        with tempfile.TemporaryDirectory() as directory:
            executor = BenchmarkExecutor(
                Path(directory) / "benchmark.json", {"routes": [route]}, Path(directory)
            )
            with patch.dict(os.environ, {"MINIMAX_API_KEY": "minimax-secret"}, clear=True):
                resolved = executor._resolve_env(route["headless"])

            self.assertEqual(resolved["ANTHROPIC_AUTH_TOKEN"], "minimax-secret")
            self.assertNotIn("MINIMAX_API_KEY", resolved)

    def _codex_executor(self, directory: str, script: str, timeout: float = 30) -> BenchmarkExecutor:
        route = {
            "name": "codex",
            "headless": {
                "env": {},
                "worker": {
                    "argv": [sys.executable, "-c", script, "{output_file}"],
                    "output_format": "codex_last_message",
                    "timeout_seconds": timeout,
                },
            },
        }
        return BenchmarkExecutor(
            Path(directory) / "benchmark.json", {"routes": [route]}, Path(directory)
        )

    def test_the_codex_scratch_file_is_removed_on_every_exit_path(self) -> None:
        write = "import pathlib,sys;pathlib.Path(sys.argv[-1]).write_text('final message')"
        cases = {
            # The child writes and exits cleanly.
            "success": (write, 30, "success"),
            # The child fails before writing anything.
            "process_error": ("import sys;sys.exit(1)", 30, "process_error"),
            # The child exits zero without writing, so the scratch file stays
            # empty and the call reports an empty answer rather than a failure.
            "empty_output": ("pass", 30, "success"),
            # The child outlives its deadline and the process group is stopped.
            "timeout": ("import time;time.sleep(30)", 1, "timeout"),
        }

        for label, (script, timeout, expected) in cases.items():
            with self.subTest(exit_path=label), tempfile.TemporaryDirectory() as directory:
                created: list[Path] = []
                real_mkstemp = tempfile.mkstemp

                def scoped_mkstemp(*args: Any, **kwargs: Any) -> tuple[int, str]:
                    # Keep the scratch file inside this test's directory so the
                    # assertion never depends on shared /tmp state.
                    kwargs["dir"] = directory
                    descriptor, path = real_mkstemp(*args, **kwargs)
                    created.append(Path(path))
                    return descriptor, path

                executor = self._codex_executor(directory, script, timeout)
                with patch("benchmark_executor.tempfile.mkstemp", scoped_mkstemp):
                    result = executor.execute_model("codex", "worker", "prompt")

                self.assertEqual(result.status, expected)
                self.assertEqual(len(created), 1)
                self.assertFalse(created[0].exists())

    def test_a_codex_call_never_reads_the_message_of_an_earlier_one(self) -> None:
        # Without a unique scratch file per call, a child that exits zero
        # without writing would surface the previous call's answer as its own.
        with tempfile.TemporaryDirectory() as directory:
            writer = self._codex_executor(
                directory,
                "import pathlib,sys;pathlib.Path(sys.argv[-1]).write_text('first answer')",
            )
            silent = self._codex_executor(directory, "pass")

            first = writer.execute_model("codex", "worker", "prompt")
            second = silent.execute_model("codex", "worker", "prompt")

            self.assertEqual(first.status, "success")
            self.assertEqual(first.output, "first answer")
            # The silent call gets its own empty scratch file, so it reports an
            # empty answer instead of inheriting the previous one.
            self.assertEqual(second.output, "")


if __name__ == "__main__":
    unittest.main()
