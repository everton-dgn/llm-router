from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import stage_verifier

from stage_verifier import (
    StageVerifierError,
    _baseline_directory,
    _working_fingerprint,
    prepare,
    verify,
)


class StageVerifierTests(unittest.TestCase):
    def setUp(self) -> None:
        self.project = Path(tempfile.mkdtemp(prefix="llm-router-stage-project-"))
        self.artifacts = Path(tempfile.mkdtemp(prefix="llm-router-stage-artifacts-"))
        self.config = self.project / "config.json"
        self.log = self.artifacts / "events.jsonl"
        self.baselines: list[str] = []
        self._git("init", "-q")
        self._git("config", "user.name", "Stage Verifier Test")
        self._git("config", "user.email", "stage-verifier@example.invalid")
        (self.project / "tracked.txt").write_text("before\n", encoding="utf-8")
        self._git("add", "tracked.txt")
        self._git("commit", "-q", "-m", "initial")

    def _git(self, *argv: str) -> subprocess.CompletedProcess[str]:
        result = subprocess.run(
            ["git", *argv],
            cwd=self.project,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
            shell=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def _write_config(self, rules: list[dict[str, object]], **extra: object) -> None:
        payload = {**extra, "verification": {"rules": rules}}
        self.config.write_text(json.dumps(payload), encoding="utf-8")

    def _prepare(self, **extra: object) -> dict[str, object]:
        result = prepare(
            {
                "project_root": str(self.project),
                "config_path": str(self.config),
                "log_path": str(self.log),
                **extra,
            }
        )
        self.baselines.append(str(result["baseline_id"]))
        return result

    @staticmethod
    def _rule(argv: list[str], **gate_overrides: object) -> dict[str, object]:
        gate: dict[str, object] = {
            "type": "command",
            "argv": argv,
            "timeout_seconds": 2,
            **gate_overrides,
        }
        return {
            "name": "python-files",
            "match": {"changed_any": ["*.txt", "**/*.txt"]},
            "gates": [gate],
        }

    def test_fingerprint_includes_content_mode_and_type(self) -> None:
        path = self.project / "tracked.txt"
        initial = _working_fingerprint(path)
        path.write_text("after\n", encoding="utf-8")
        content_changed = _working_fingerprint(path)
        self.assertNotEqual(initial["sha256"], content_changed["sha256"])

        path.chmod(0o600)
        mode_changed = _working_fingerprint(path)
        self.assertEqual(mode_changed["mode"], 0o600)
        self.assertNotEqual(content_changed["sha256"], mode_changed["sha256"])

        directory = self.project / "directory"
        directory.mkdir()
        type_changed = _working_fingerprint(directory)
        self.assertEqual(type_changed["type"], "directory")
        self.assertNotEqual(mode_changed["sha256"], type_changed["sha256"])

    def test_no_changes_consumes_one_shot_baseline(self) -> None:
        self._write_config([])
        prepared = self._prepare()
        baseline_directory = _baseline_directory(str(prepared["baseline_id"]))
        self.assertEqual(baseline_directory.stat().st_mode & 0o777, 0o700)
        self.assertEqual((baseline_directory / "baseline.json").stat().st_mode & 0o777, 0o600)
        result = verify({"baseline_id": prepared["baseline_id"]})
        self.assertEqual(result["status"], "no_changes")
        self.assertTrue(baseline_directory.is_dir())
        self.assertTrue((baseline_directory / "baseline.json").is_file())
        consumed = baseline_directory / stage_verifier.BASELINE_CONSUMED_NAME
        self.assertTrue(consumed.is_file())
        self.assertEqual(consumed.stat().st_mode & 0o777, 0o600)
        self.assertEqual(consumed.stat().st_size, 0)
        with self.assertRaisesRegex(StageVerifierError, "already consumed"):
            verify({"baseline_id": prepared["baseline_id"]})

    def test_matching_rule_runs_argv_without_shell_and_logs_no_prompt(self) -> None:
        self._write_config(
            [self._rule([sys.executable, "-c", "print('TOP SECRET PROMPT')"])],
            auto={"verifiers": {"auto_select": {"rules": []}}},
        )
        prepared = self._prepare()
        (self.project / "tracked.txt").write_text("after\n", encoding="utf-8")
        result = verify({"baseline_id": prepared["baseline_id"]})
        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["selected_rules"], ["python-files"])
        self.assertEqual(result["gates"][0]["stdout"], "TOP SECRET PROMPT\n")
        log_text = self.log.read_text(encoding="utf-8")
        self.assertNotIn("TOP SECRET PROMPT", log_text)
        self.assertNotIn('"prompt"', log_text)
        for line in log_text.splitlines():
            self.assertIsInstance(json.loads(line), dict)

    def test_nonzero_exit_is_fail_unless_declared_infrastructure(self) -> None:
        self._write_config([self._rule([sys.executable, "-c", "raise SystemExit(7)"])])
        prepared = self._prepare()
        (self.project / "tracked.txt").write_text("after\n", encoding="utf-8")
        failed = verify({"baseline_id": prepared["baseline_id"]})
        self.assertEqual(failed["status"], "fail")
        self.assertEqual(failed["gates"][0]["exit_code"], 7)

        self._write_config(
            [
                self._rule(
                    [sys.executable, "-c", "raise SystemExit(7)"],
                    error_exit_codes=[7],
                )
            ]
        )
        prepared = self._prepare()
        (self.project / "tracked.txt").write_text("again\n", encoding="utf-8")
        errored = verify({"baseline_id": prepared["baseline_id"]})
        self.assertEqual(errored["status"], "infrastructure_error")

    def test_timeout_is_infrastructure_error(self) -> None:
        self._write_config(
            [
                self._rule(
                    [sys.executable, "-c", "import time; time.sleep(5)"],
                    timeout_seconds=0.05,
                )
            ]
        )
        prepared = self._prepare()
        (self.project / "tracked.txt").write_text("after\n", encoding="utf-8")
        result = verify({"baseline_id": prepared["baseline_id"]})
        self.assertEqual(result["status"], "infrastructure_error")
        self.assertIn("timed out", result["gates"][0]["stderr"])

    def test_total_gate_evidence_respects_configured_limit(self) -> None:
        payload = {
            "verification": {
                "evidence_max_chars": 10,
                "rules": [
                    self._rule(
                        [
                            sys.executable,
                            "-c",
                            "import sys; print('abcdefghij'); print('klmnopqrst', file=sys.stderr)",
                        ]
                    )
                ],
            }
        }
        self.config.write_text(json.dumps(payload), encoding="utf-8")
        prepared = self._prepare()
        (self.project / "tracked.txt").write_text("after\n", encoding="utf-8")
        result = verify({"baseline_id": prepared["baseline_id"]})
        evidence_size = sum(
            len(gate["stdout"]) + len(gate["stderr"]) for gate in result["gates"]
        )
        self.assertLessEqual(evidence_size, 10)

    def test_changed_files_without_matching_rule_have_no_applicable_gates(self) -> None:
        self._write_config(
            [
                {
                    "name": "python-only",
                    "match": {"changed_any": ["*.py"]},
                    "gates": [{"type": "command", "argv": [sys.executable, "-c", "pass"]}],
                }
            ]
        )
        prepared = self._prepare()
        (self.project / "tracked.txt").write_text("after\n", encoding="utf-8")
        result = verify({"baseline_id": prepared["baseline_id"]})
        self.assertEqual(result["status"], "no_applicable_gates")
        self.assertEqual(result["changed_files"], ["tracked.txt"])

    def test_string_command_is_rejected_instead_of_using_a_shell(self) -> None:
        self._write_config([self._rule([sys.executable, "-c", "pass"])])
        payload = json.loads(self.config.read_text(encoding="utf-8"))
        payload["verification"]["rules"][0]["gates"][0]["argv"] = "echo unsafe"
        self.config.write_text(json.dumps(payload), encoding="utf-8")
        prepared = self._prepare()
        (self.project / "tracked.txt").write_text("after\n", encoding="utf-8")
        result = verify({"baseline_id": prepared["baseline_id"]})
        self.assertEqual(result["status"], "infrastructure_error")
        self.assertIn("argv", result["gates"][0]["stderr"])

    def test_json_keys_and_command_requirements_select_rule(self) -> None:
        package = self.project / "package.json"
        package.write_text(json.dumps({"scripts": {"test": "ok"}}), encoding="utf-8")
        command = Path(sys.executable).name
        self._write_config(
            [
                {
                    "name": "metadata",
                    "match": {
                        "files_all": ["package.json"],
                        "commands_all": [command],
                        "json_keys_all": [{"path": "package.json", "keys": ["scripts.test"]}],
                        "changed_any": ["*.txt"],
                    },
                    "gates": [{"type": "command", "argv": [sys.executable, "-c", "pass"]}],
                }
            ]
        )
        prepared = self._prepare()
        (self.project / "tracked.txt").write_text("after\n", encoding="utf-8")
        result = verify({"baseline_id": prepared["baseline_id"]})
        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["selected_rules"], ["metadata"])

    def test_preexisting_tracked_change_is_excluded(self) -> None:
        self._write_config([])
        (self.project / "tracked.txt").write_text("preexisting\n", encoding="utf-8")
        prepared = self._prepare()
        result = verify({"baseline_id": prepared["baseline_id"]})
        self.assertEqual(result["status"], "no_changes")
        self.assertEqual(result["changed_files"], [])

    def test_commit_created_during_stage_is_detected(self) -> None:
        self._write_config([])
        prepared = self._prepare()
        (self.project / "tracked.txt").write_text("committed during stage\n", encoding="utf-8")
        self._git("add", "tracked.txt")
        self._git("commit", "-q", "-m", "stage change")
        result = verify({"baseline_id": prepared["baseline_id"]})
        self.assertEqual(result["status"], "fail")
        self.assertEqual(result["changed_files"], ["tracked.txt"])
        self.assertTrue(result["head_changed"])
        self.assertEqual(result["gates"][0]["selected_rule"], "git-head-integrity")

    def test_empty_commit_created_during_stage_is_detected(self) -> None:
        self._write_config([])
        prepared = self._prepare()
        self._git("commit", "--allow-empty", "-q", "-m", "empty stage commit")

        result = verify({"baseline_id": prepared["baseline_id"]})

        self.assertEqual(result["status"], "fail")
        self.assertEqual(result["changed_files"], [])
        self.assertTrue(result["head_changed"])
        self.assertEqual(len(result["gates"]), 1)
        self.assertIn("HEAD changed", result["gates"][0]["stderr"])

    def test_all_selected_gates_run_after_failure(self) -> None:
        marker = self.artifacts / "second-gate-ran.txt"
        first = self._rule([sys.executable, "-c", "raise SystemExit(9)"])
        first["gates"].append(
            {
                "type": "command",
                "argv": [sys.executable, "-c", f"from pathlib import Path; Path({str(marker)!r}).write_text('yes')"],
                "timeout_seconds": 2,
            }
        )
        self._write_config([first])
        prepared = self._prepare()
        (self.project / "tracked.txt").write_text("after\n", encoding="utf-8")

        result = verify({"baseline_id": prepared["baseline_id"]})

        self.assertEqual(result["status"], "fail")
        self.assertEqual([gate["status"] for gate in result["gates"]], ["fail", "pass"])
        self.assertEqual(marker.read_text(encoding="utf-8"), "yes")

    def test_infrastructure_error_takes_precedence_over_failure(self) -> None:
        rule = self._rule([sys.executable, "-c", "raise SystemExit(9)"])
        rule["gates"].append(
            {
                "type": "command",
                "argv": [sys.executable, "-c", "raise SystemExit(8)"],
                "error_exit_codes": [8],
                "timeout_seconds": 2,
            }
        )
        self._write_config([rule])
        prepared = self._prepare()
        (self.project / "tracked.txt").write_text("after\n", encoding="utf-8")

        result = verify({"baseline_id": prepared["baseline_id"]})

        self.assertEqual(result["status"], "infrastructure_error")
        self.assertEqual(
            [gate["status"] for gate in result["gates"]],
            ["fail", "infrastructure_error"],
        )

    def test_gate_created_delta_is_infrastructure_error(self) -> None:
        self._write_config(
            [
                self._rule(
                    [
                        sys.executable,
                        "-c",
                        "from pathlib import Path; Path('gate-output.txt').write_text('generated')",
                    ]
                )
            ]
        )
        prepared = self._prepare()
        (self.project / "tracked.txt").write_text("after\n", encoding="utf-8")

        result = verify({"baseline_id": prepared["baseline_id"]})

        self.assertEqual(result["status"], "infrastructure_error")
        self.assertEqual(result["changed_files"], ["gate-output.txt", "tracked.txt"])
        self.assertEqual(result["gates"][-1]["selected_rule"], "verification-integrity")

    def test_gate_rewriting_existing_delta_is_infrastructure_error(self) -> None:
        self._write_config(
            [
                self._rule(
                    [
                        sys.executable,
                        "-c",
                        "from pathlib import Path; Path('tracked.txt').write_text('gate rewrite')",
                    ]
                )
            ]
        )
        prepared = self._prepare()
        (self.project / "tracked.txt").write_text("worker change\n", encoding="utf-8")

        result = verify({"baseline_id": prepared["baseline_id"]})

        self.assertEqual(result["status"], "infrastructure_error")
        self.assertEqual(result["changed_files"], ["tracked.txt"])
        self.assertIn("rewritten delta paths: tracked.txt", result["gates"][-1]["stderr"])

    def test_gate_staging_existing_delta_is_infrastructure_error(self) -> None:
        self._write_config([self._rule(["git", "add", "tracked.txt"])])
        prepared = self._prepare()
        (self.project / "tracked.txt").write_text("worker change\n", encoding="utf-8")

        result = verify({"baseline_id": prepared["baseline_id"]})

        self.assertEqual(result["status"], "infrastructure_error")
        self.assertEqual(result["changed_files"], ["tracked.txt"])
        self.assertIn("index changed: True", result["gates"][-1]["stderr"])

    def test_changed_gate_input_is_not_executed(self) -> None:
        marker = self.artifacts / "untrusted-gate-ran.txt"
        self._write_config(
            [
                self._rule(
                    [sys.executable, "-c", f"from pathlib import Path; Path({str(marker)!r}).write_text('unsafe')"],
                    untrusted_if_changed=["tracked.txt"],
                )
            ]
        )
        prepared = self._prepare()
        (self.project / "tracked.txt").write_text("after\n", encoding="utf-8")

        result = verify({"baseline_id": prepared["baseline_id"]})

        self.assertEqual(result["status"], "infrastructure_error")
        self.assertFalse(marker.exists())
        self.assertIn("gate inputs changed", result["gates"][0]["stderr"])

    def test_executable_mode_change_is_detected(self) -> None:
        self._write_config([])
        prepared = self._prepare()
        (self.project / "tracked.txt").chmod(0o755)
        result = verify({"baseline_id": prepared["baseline_id"]})
        self.assertEqual(result["status"], "no_applicable_gates")
        self.assertEqual(result["changed_files"], ["tracked.txt"])

    def test_sensitive_tracked_file_is_detected_without_reading_git_blob(self) -> None:
        self._write_config([])
        sensitive = self.project / "secret.pem"
        sensitive.write_text("fixture-before\n", encoding="utf-8")
        self._git("add", "secret.pem")
        self._git("commit", "-q", "-m", "add sensitive fixture")
        prepared = self._prepare()
        sensitive.write_text("fixture-after\n", encoding="utf-8")

        original_run_git = stage_verifier._run_git

        def guarded_run_git(
            project_root: Path, argv: list[str], *, binary: bool = False
        ) -> str | bytes:
            self.assertNotEqual(argv[0], "cat-file")
            return original_run_git(project_root, argv, binary=binary)

        with mock.patch("stage_verifier._run_git", side_effect=guarded_run_git):
            result = verify({"baseline_id": prepared["baseline_id"]})

        self.assertEqual(result["status"], "no_applicable_gates")
        self.assertEqual(result["changed_files"], ["secret.pem"])

    def test_cli_prepare_and_verify_exchange_json_on_stdin(self) -> None:
        self._write_config([])
        script = Path(__file__).resolve().parents[1] / "stage_verifier.py"
        prepared_process = subprocess.run(
            [sys.executable, str(script), "prepare"],
            input=json.dumps(
                {
                    "project_root": str(self.project),
                    "config_path": str(self.config),
                    "log_path": str(self.log),
                }
            ),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
            shell=False,
        )
        self.assertEqual(prepared_process.returncode, 0, prepared_process.stderr)
        prepared = json.loads(prepared_process.stdout)
        self.assertEqual(prepared["status"], "prepared")
        self.assertNotIn("baseline_path", prepared)
        self.baselines.append(prepared["baseline_id"])

        verified_process = subprocess.run(
            [sys.executable, str(script), "verify"],
            input=json.dumps({"baseline_id": prepared["baseline_id"]}),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
            shell=False,
        )
        self.assertEqual(verified_process.returncode, 0, verified_process.stderr)
        self.assertEqual(json.loads(verified_process.stdout)["status"], "no_changes")


if __name__ == "__main__":
    unittest.main()
