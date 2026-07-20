#!/usr/bin/env python3
"""Config-driven headless model cascade for llm-router."""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ENV_PATTERN = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


class ConfigError(RuntimeError):
    """Raised when the auto configuration cannot be executed safely."""


@dataclass
class ProcessResult:
    status: str
    exit_code: int | None
    output: str
    stdout: str
    stderr: str
    duration_seconds: float


@dataclass
class VerificationResult:
    status: str
    feedback: str = ""
    details: dict[str, Any] = field(default_factory=dict)


@dataclass
class WorkspaceBaseline:
    head: str | None
    dirty_fingerprints: dict[str, str]


@dataclass
class Vote:
    verdict: str
    confidence: float
    failures: list[str]
    repair_instructions: list[str]
    judge_route: str = ""
    valid: bool = False

    def feedback(self) -> str:
        parts = [*self.failures, *self.repair_instructions]
        return "\n".join(part for part in parts if part).strip()

    def anonymized(self) -> dict[str, Any]:
        return {
            "verdict": self.verdict,
            "confidence": self.confidence,
            "failures": self.failures,
            "repair_instructions": self.repair_instructions,
        }


class EventLogger:
    def __init__(
        self,
        config_path: Path,
        log_config: dict[str, Any],
        run_id: str,
    ) -> None:
        raw_path = log_config.get("path", "logs/auto.jsonl")
        if not isinstance(raw_path, str) or not raw_path:
            raise ConfigError("auto.log.path precisa ser uma string nao vazia")
        path = Path(expand_env_string(raw_path))
        self.path = path if path.is_absolute() else config_path.parent / path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.run_id = run_id
        self.include_prompt = bool(log_config.get("include_prompt", False))
        self.include_output = bool(log_config.get("include_output", False))

    def write(self, event: str, **fields: Any) -> None:
        record = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "run_id": self.run_id,
            "event": event,
            **fields,
        }
        with self.path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")))
            stream.write("\n")


def expand_env_string(value: str) -> str:
    def replace(match: re.Match[str]) -> str:
        name = match.group(1)
        if name not in os.environ:
            raise ConfigError(f"variavel de ambiente obrigatoria ausente: {name}")
        return os.environ[name]

    return ENV_PATTERN.sub(replace, value)


def truncate(value: str, limit: int) -> str:
    if limit < 0 or len(value) <= limit:
        return value
    return value[:limit] + "\n[conteudo truncado pelo llm-router]"


def content_metadata(name: str, value: str, include: bool) -> dict[str, Any]:
    result: dict[str, Any] = {
        f"{name}_sha256": hashlib.sha256(value.encode("utf-8")).hexdigest(),
        f"{name}_chars": len(value),
    }
    if include:
        result[name] = value
    return result


def parse_json_object(value: str) -> dict[str, Any]:
    text = value.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if lines:
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass

    decoder = json.JSONDecoder()
    for index, char in enumerate(text):
        if char != "{":
            continue
        try:
            parsed, _ = decoder.raw_decode(text[index:])
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed
    raise ValueError("saida nao contem objeto JSON valido")


def cleanup_temp_file(path: str | None) -> str | None:
    if not path or not os.path.exists(path):
        return None
    trash = shutil.which("trash")
    if not trash:
        return f"trash nao encontrado; arquivo temporario preservado em {path}"
    result = subprocess.run(
        [trash, path],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or f"exit code {result.returncode}"
        return f"trash falhou para {path}: {detail}"
    return None


def stop_process_group(process: subprocess.Popen[str]) -> tuple[str, str]:
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        return process.communicate(timeout=2)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        return process.communicate()


def normalize_output(output_format: str, stdout: str, output_file: str | None) -> str:
    if output_format == "text":
        return stdout.strip()
    if output_format == "claude_json":
        payload = parse_json_object(stdout)
        result = payload.get("result")
        if not isinstance(result, str):
            raise ValueError("saida claude_json sem campo result textual")
        return result.strip()
    if output_format == "codex_last_message":
        if not output_file:
            raise ValueError("codex_last_message exige {output_file} no argv")
        try:
            return Path(output_file).read_text(encoding="utf-8").strip()
        except OSError as error:
            raise ValueError(f"nao foi possivel ler a ultima mensagem do Codex: {error}") from error
    raise ValueError(f"output_format desconhecido: {output_format}")


class AutoRunner:
    def __init__(
        self,
        config_path: Path,
        config: dict[str, Any],
        cwd: Path,
        initial_route: str,
        prompt: str,
        verifier_name: str | None,
    ) -> None:
        self.config_path = config_path
        self.config = config
        self.cwd = cwd
        self.git_root = self._find_git_root(cwd)
        self.project_root = self.git_root or cwd
        self.initial_route = initial_route
        self.original_prompt = prompt
        self.routes = self._load_routes(config.get("routes"))
        self.auto = self._require_dict(config.get("auto"), "auto")
        self.verifiers = self._require_dict(self.auto.get("verifiers"), "auto.verifiers")
        self.verifier_name = verifier_name or self._require_string(
            self.auto.get("default_verifier"), "auto.default_verifier"
        )
        if self.verifier_name not in self.verifiers:
            raise ConfigError(f"verificador desconhecido: {self.verifier_name}")
        if initial_route not in self.routes:
            raise ConfigError(f"rota inicial desconhecida: {initial_route}")

        self.max_worker_attempts = self._positive_int(
            self.auto.get("max_worker_attempts"), "auto.max_worker_attempts"
        )
        self.max_judge_sessions = self._positive_int(
            self.auto.get("max_judge_sessions"), "auto.max_judge_sessions"
        )
        self.max_total_sessions = self._positive_int(
            self.auto.get("max_total_sessions"), "auto.max_total_sessions"
        )
        self.max_total_seconds = self._positive_number(
            self.auto.get("max_total_seconds"), "auto.max_total_seconds"
        )
        self.feedback_max_chars = int(self.auto.get("feedback_max_chars", 20000))
        self.evidence_max_chars = int(self.auto.get("evidence_max_chars", 30000))
        self.worker_attempts = 0
        self.judge_sessions = 0
        self.total_sessions = 0
        self.worker_changed_files: list[str] = []
        self.started_at = time.monotonic()
        self.run_id = str(uuid.uuid4())
        log_config = self._require_dict(self.auto.get("log", {}), "auto.log")
        self.logger = EventLogger(config_path, log_config, self.run_id)

        ladders = self._require_dict(self.auto.get("ladders"), "auto.ladders")
        ladder = ladders.get(initial_route)
        if not isinstance(ladder, list) or not ladder:
            raise ConfigError(f"ladder ausente ou vazia para a rota {initial_route}")
        if not all(isinstance(item, str) and item in self.routes for item in ladder):
            raise ConfigError(f"ladder de {initial_route} contem rota invalida")
        self.ladder = ladder

        retry = self._require_dict(self.auto.get("retry_same_route", {}), "auto.retry_same_route")
        max_retries = retry.get("max_retries", 0)
        if not isinstance(max_retries, int) or max_retries < 0:
            raise ConfigError("auto.retry_same_route.max_retries precisa ser inteiro >= 0")
        retry_on = retry.get("on", [])
        if not isinstance(retry_on, list) or not all(isinstance(item, str) for item in retry_on):
            raise ConfigError("auto.retry_same_route.on precisa ser uma lista de strings")
        self.max_same_route_retries = max_retries
        self.retry_on = set(retry_on)

    @staticmethod
    def _require_dict(value: Any, path: str) -> dict[str, Any]:
        if not isinstance(value, dict):
            raise ConfigError(f"{path} precisa ser um objeto")
        return value

    @staticmethod
    def _require_string(value: Any, path: str) -> str:
        if not isinstance(value, str) or not value:
            raise ConfigError(f"{path} precisa ser uma string nao vazia")
        return value

    @staticmethod
    def _positive_int(value: Any, path: str) -> int:
        if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
            raise ConfigError(f"{path} precisa ser um inteiro positivo")
        return value

    @staticmethod
    def _positive_number(value: Any, path: str) -> float:
        if not isinstance(value, (int, float)) or isinstance(value, bool) or value <= 0:
            raise ConfigError(f"{path} precisa ser um numero positivo")
        return float(value)

    def _load_routes(self, routes: Any) -> dict[str, dict[str, Any]]:
        if not isinstance(routes, list) or not routes:
            raise ConfigError("routes precisa ser uma lista nao vazia")
        result: dict[str, dict[str, Any]] = {}
        for route in routes:
            if not isinstance(route, dict):
                raise ConfigError("cada item de routes precisa ser um objeto")
            name = route.get("name")
            if not isinstance(name, str) or not name:
                raise ConfigError("routes[].name precisa ser uma string nao vazia")
            if name in result:
                raise ConfigError(f"rota duplicada: {name}")
            result[name] = route
        return result

    @staticmethod
    def _find_git_root(cwd: Path) -> Path | None:
        try:
            result = subprocess.run(
                ["git", "rev-parse", "--show-toplevel"],
                cwd=cwd,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                timeout=10,
                check=False,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
            return None
        if result.returncode != 0 or not result.stdout.strip():
            return None
        return Path(result.stdout.strip()).resolve()

    def remaining_seconds(self) -> float:
        return self.max_total_seconds - (time.monotonic() - self.started_at)

    def deadline_reached(self) -> bool:
        return self.remaining_seconds() <= 0

    def _configured_env(self, raw_env: Any, path: str) -> dict[str, str]:
        raw_env = self._require_dict(raw_env, path)
        env = os.environ.copy()
        for name, value in raw_env.items():
            if not isinstance(name, str) or not name:
                raise ConfigError(f"nome invalido em {path}")
            if isinstance(value, str):
                env[name] = expand_env_string(value)
                continue
            if isinstance(value, dict) and isinstance(value.get("from_env"), str):
                source = value["from_env"]
                if source not in os.environ or not os.environ[source]:
                    raise ConfigError(f"variavel de ambiente obrigatoria ausente: {source}")
                env[name] = os.environ[source]
                continue
            raise ConfigError(f"valor de ambiente invalido para {name}")
        return env

    def _resolve_env(self, headless: dict[str, Any]) -> dict[str, str]:
        return self._configured_env(headless.get("env", {}), "routes[].headless.env")

    def _prepare_argv(
        self,
        raw_argv: Any,
        output_file: str | None,
        process_cwd: Path,
    ) -> list[str]:
        if not isinstance(raw_argv, list) or not raw_argv or not all(
            isinstance(item, str) for item in raw_argv
        ):
            raise ConfigError("headless.argv precisa ser uma lista nao vazia de strings")
        values = {
            "cwd": str(process_cwd),
            "project_root": str(self.project_root),
            "output_file": output_file or "",
        }
        argv: list[str] = []
        for item in raw_argv:
            expanded = expand_env_string(item)
            for key, value in values.items():
                expanded = expanded.replace("{" + key + "}", value)
            argv.append(expanded)
        return argv

    def execute_model(self, route_name: str, role: str, prompt: str) -> ProcessResult:
        started = time.monotonic()
        output_file: str | None = None
        try:
            route = self.routes[route_name]
            headless = self._require_dict(route.get("headless"), f"routes[{route_name}].headless")
            profile = self._require_dict(headless.get(role), f"routes[{route_name}].headless.{role}")
            timeout = self._positive_number(
                profile.get("timeout_seconds"), f"routes[{route_name}].headless.{role}.timeout_seconds"
            )
            if self.deadline_reached():
                return ProcessResult("timeout", None, "", "", "deadline global esgotado", 0.0)
            timeout = min(timeout, max(self.remaining_seconds(), 0.001))
            raw_argv = profile.get("argv")
            needs_output_file = (
                profile.get("output_format") == "codex_last_message"
                or isinstance(raw_argv, list)
                and any("{output_file}" in str(item) for item in raw_argv)
            )
            if needs_output_file:
                if not shutil.which("trash"):
                    raise ConfigError(
                        "trash e obrigatorio para limpar a saida temporaria do Codex"
                    )
                descriptor, output_file = tempfile.mkstemp(prefix="llm-router-", suffix=".out")
                os.close(descriptor)
            argv = self._prepare_argv(raw_argv, output_file, self.cwd)
            env = self._resolve_env(headless)
            process = subprocess.Popen(
                argv,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                cwd=self.cwd,
                env=env,
                start_new_session=True,
            )
            try:
                stdout, stderr = process.communicate(input=prompt, timeout=timeout)
            except subprocess.TimeoutExpired:
                stdout, stderr = stop_process_group(process)
                return ProcessResult(
                    "timeout",
                    process.returncode,
                    "",
                    stdout or "",
                    stderr or "",
                    time.monotonic() - started,
                )
            except BaseException:
                stop_process_group(process)
                raise
            if process.returncode != 0:
                return ProcessResult(
                    "process_error",
                    process.returncode,
                    "",
                    stdout,
                    stderr,
                    time.monotonic() - started,
                )
            try:
                output = normalize_output(
                    self._require_string(profile.get("output_format"), "headless.output_format"),
                    stdout,
                    output_file,
                )
            except ValueError as error:
                return ProcessResult(
                    "process_error",
                    process.returncode,
                    "",
                    stdout,
                    f"{stderr}\n{error}".strip(),
                    time.monotonic() - started,
                )
            return ProcessResult(
                "success",
                process.returncode,
                output,
                stdout,
                stderr,
                time.monotonic() - started,
            )
        except (ConfigError, FileNotFoundError, OSError) as error:
            return ProcessResult(
                "process_error",
                None,
                "",
                "",
                str(error),
                time.monotonic() - started,
            )
        finally:
            cleanup_error = cleanup_temp_file(output_file)
            if cleanup_error:
                print(f"aviso: {cleanup_error}", file=sys.stderr)

    def collect_evidence(self) -> str:
        pieces: list[str] = []
        commands = [
            ["git", "status", "--short"],
            ["git", "diff", "--no-ext-diff"],
        ]
        for command in commands:
            try:
                result = subprocess.run(
                    command,
                    cwd=self.cwd,
                    text=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    timeout=10,
                    check=False,
                )
            except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
                continue
            if result.returncode == 0 and result.stdout.strip():
                pieces.append(f"$ {' '.join(command)}\n{result.stdout.strip()}")
        return truncate("\n\n".join(pieces), self.evidence_max_chars)

    def _git_paths(self, argv: list[str]) -> list[str]:
        if self.git_root is None:
            return []
        try:
            result = subprocess.run(
                argv,
                cwd=self.project_root,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                timeout=10,
                check=False,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
            return []
        if result.returncode != 0:
            return []
        return [path for path in result.stdout.split("\0") if path]

    def _head_revision(self) -> str | None:
        if self.git_root is None:
            return None
        try:
            result = subprocess.run(
                ["git", "rev-parse", "--verify", "HEAD"],
                cwd=self.project_root,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                timeout=10,
                check=False,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
            return None
        if result.returncode != 0 or not result.stdout.strip():
            return None
        return result.stdout.strip()

    def workspace_changed_files(self) -> list[str]:
        paths = set(
            self._git_paths(["git", "diff", "--name-only", "--relative", "-z", "HEAD"])
        )
        paths.update(
            self._git_paths(["git", "ls-files", "--others", "--exclude-standard", "-z"])
        )
        return sorted(paths)

    def _working_fingerprint(self, relative_path: str) -> str:
        path = self.project_root / relative_path
        if not path.exists() and not path.is_symlink():
            return "missing"
        try:
            result = subprocess.run(
                ["git", "hash-object", "--no-filters", "--", relative_path],
                cwd=self.project_root,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                timeout=10,
                check=False,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
            result = None
        if result is not None and result.returncode == 0 and result.stdout.strip():
            return f"git:{result.stdout.strip()}"
        try:
            stat = path.lstat()
        except OSError:
            return "unreadable"
        return f"stat:{stat.st_mode}:{stat.st_size}:{stat.st_mtime_ns}"

    def capture_workspace_baseline(self) -> WorkspaceBaseline:
        dirty = self.workspace_changed_files()
        return WorkspaceBaseline(
            head=self._head_revision(),
            dirty_fingerprints={path: self._working_fingerprint(path) for path in dirty},
        )

    def changes_since_baseline(self, baseline: WorkspaceBaseline) -> list[str]:
        current_dirty = self.workspace_changed_files()
        changed = {
            path
            for path in current_dirty
            if path not in baseline.dirty_fingerprints
            or self._working_fingerprint(path) != baseline.dirty_fingerprints[path]
        }
        current_head = self._head_revision()
        if current_head and current_head != baseline.head:
            if baseline.head:
                committed = self._git_paths(
                    [
                        "git",
                        "diff",
                        "--name-only",
                        "--relative",
                        "-z",
                        baseline.head,
                        current_head,
                    ]
                )
            else:
                committed = self._git_paths(
                    ["git", "show", "--format=", "--name-only", "-z", current_head]
                )
            changed.update(committed)
        return sorted(changed)

    @staticmethod
    def _string_list_config(value: Any, path: str) -> list[str]:
        if not isinstance(value, list) or not value or not all(
            isinstance(item, str) and item for item in value
        ):
            raise ConfigError(f"{path} precisa ser uma lista nao vazia de strings")
        return value

    @staticmethod
    def _matches_any(paths: list[str], patterns: list[str]) -> bool:
        return any(fnmatch.fnmatch(path, pattern) for path in paths for pattern in patterns)

    @staticmethod
    def _json_key_exists(payload: Any, dotted_key: str) -> bool:
        current = payload
        for part in dotted_key.split("."):
            if not isinstance(current, dict) or part not in current:
                return False
            current = current[part]
        if current is None:
            return False
        if isinstance(current, str):
            return bool(current.strip())
        return True

    def _json_keys_match(self, specs: Any, path: str) -> bool:
        if not isinstance(specs, list) or not specs:
            raise ConfigError(f"{path} precisa ser uma lista nao vazia")
        for index, raw_spec in enumerate(specs):
            spec = self._require_dict(raw_spec, f"{path}[{index}]")
            relative_path = self._require_string(spec.get("path"), f"{path}[{index}].path")
            keys = self._string_list_config(spec.get("keys"), f"{path}[{index}].keys")
            try:
                with (self.project_root / relative_path).open(encoding="utf-8") as stream:
                    payload = json.load(stream)
            except (OSError, json.JSONDecodeError):
                return False
            if not all(self._json_key_exists(payload, key) for key in keys):
                return False
        return True

    def _auto_rule_matches(
        self,
        rule: dict[str, Any],
        changed_files: list[str],
        path: str,
    ) -> bool:
        match = self._require_dict(rule.get("match", {}), f"{path}.match")
        allowed_keys = {
            "files_all",
            "files_any",
            "changed_any",
            "commands_all",
            "json_keys_all",
        }
        unknown_keys = sorted(set(match) - allowed_keys)
        if unknown_keys:
            raise ConfigError(f"chaves desconhecidas em {path}.match: {', '.join(unknown_keys)}")
        if "files_all" in match:
            markers = self._string_list_config(match["files_all"], f"{path}.match.files_all")
            if not all((self.project_root / marker).exists() for marker in markers):
                return False
        if "files_any" in match:
            markers = self._string_list_config(match["files_any"], f"{path}.match.files_any")
            if not any((self.project_root / marker).exists() for marker in markers):
                return False
        if "changed_any" in match:
            patterns = self._string_list_config(match["changed_any"], f"{path}.match.changed_any")
            if not self._matches_any(changed_files, patterns):
                return False
        if "commands_all" in match:
            commands = self._string_list_config(
                match["commands_all"], f"{path}.match.commands_all"
            )
            if not all(shutil.which(command) for command in commands):
                return False
        if "json_keys_all" in match and not self._json_keys_match(
            match["json_keys_all"], f"{path}.match.json_keys_all"
        ):
            return False
        return True

    def _select_auto_gates(
        self,
        verifier: dict[str, Any],
    ) -> tuple[list[dict[str, Any]], list[str], list[str]]:
        if verifier.get("evaluation") != "all_matches":
            raise ConfigError("auto_select precisa usar evaluation: all_matches")
        rules = verifier.get("rules")
        if not isinstance(rules, list) or not rules:
            raise ConfigError("auto_select.rules precisa ser uma lista nao vazia")
        changed_files = self.worker_changed_files
        selected_rules: list[str] = []
        selected_gates: list[dict[str, Any]] = []
        seen_gates: set[str] = set()
        seen_names: set[str] = set()
        for index, raw_rule in enumerate(rules):
            path = f"auto_select.rules[{index}]"
            rule = self._require_dict(raw_rule, path)
            name = self._require_string(rule.get("name"), f"{path}.name")
            if name in seen_names:
                raise ConfigError(f"regra auto_select duplicada: {name}")
            seen_names.add(name)
            if not self._auto_rule_matches(rule, changed_files, path):
                continue
            gates = rule.get("gates")
            if not isinstance(gates, list) or not gates:
                raise ConfigError(f"{path}.gates precisa ser uma lista nao vazia")
            selected_rules.append(name)
            for raw_gate in gates:
                gate = self._require_dict(raw_gate, f"{path}.gates[]").copy()
                gate_key = json.dumps(gate, sort_keys=True, separators=(",", ":"))
                if gate_key in seen_gates:
                    continue
                seen_gates.add(gate_key)
                gate["_selected_rule"] = name
                selected_gates.append(gate)
        return selected_gates, selected_rules, changed_files

    def _run_gate_command(self, gate: dict[str, Any]) -> tuple[str, str, dict[str, Any]]:
        started = time.monotonic()
        raw_argv = gate.get("argv")
        try:
            gate_cwd_raw = gate.get("cwd")
            gate_cwd = self.cwd
            if gate_cwd_raw is not None:
                if not isinstance(gate_cwd_raw, str):
                    raise ConfigError("gate command.cwd precisa ser string")
                expanded = expand_env_string(gate_cwd_raw)
                expanded = expanded.replace("{cwd}", str(self.cwd))
                expanded = expanded.replace("{project_root}", str(self.project_root))
                candidate = Path(expanded)
                gate_cwd = candidate if candidate.is_absolute() else self.cwd / candidate
            argv = self._prepare_argv(raw_argv, None, gate_cwd)
            timeout = self._positive_number(gate.get("timeout_seconds", 300), "gate.timeout_seconds")
            timeout = min(timeout, max(self.remaining_seconds(), 0.001))
            env = self._configured_env(gate.get("env", {}), "gate.env")
            process = subprocess.Popen(
                argv,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                cwd=gate_cwd,
                env=env,
                start_new_session=True,
            )
            try:
                stdout, stderr = process.communicate(timeout=timeout)
            except subprocess.TimeoutExpired:
                stdout, stderr = stop_process_group(process)
                return "error", f"gate excedeu timeout: {stderr}".strip(), {
                    "exit_code": process.returncode,
                    "duration_seconds": round(time.monotonic() - started, 3),
                }
            except BaseException:
                stop_process_group(process)
                raise
            error_exit_codes = gate.get("error_exit_codes", [])
            if not isinstance(error_exit_codes, list) or not all(
                isinstance(code, int) and not isinstance(code, bool) for code in error_exit_codes
            ):
                raise ConfigError("gate.error_exit_codes precisa ser uma lista de inteiros")
            if process.returncode == 0:
                status = "pass"
            elif process.returncode in error_exit_codes:
                status = "error"
            else:
                status = "fail"
            feedback = "\n".join(part for part in [stdout.strip(), stderr.strip()] if part)
            return status, feedback, {
                "exit_code": process.returncode,
                "duration_seconds": round(time.monotonic() - started, 3),
            }
        except (ConfigError, FileNotFoundError, OSError) as error:
            return "error", str(error), {
                "exit_code": None,
                "duration_seconds": round(time.monotonic() - started, 3),
            }

    def _run_gate_jq(
        self,
        gate: dict[str, Any],
        output: str,
        evidence: str,
    ) -> tuple[str, str, dict[str, Any]]:
        started = time.monotonic()
        filter_value = gate.get("filter")
        source_name = gate.get("source", "output")
        if not isinstance(filter_value, str) or not filter_value:
            return "error", "gate jq.filter precisa ser string nao vazia", {}
        if source_name not in {"output", "evidence"}:
            return "error", "gate jq.source precisa ser output ou evidence", {}
        source = output if source_name == "output" else evidence
        jq_argv = ["jq", "--exit-status", filter_value]
        if source_name == "evidence":
            jq_argv = ["jq", "--raw-input", "--slurp", "--exit-status", filter_value]
        try:
            result = subprocess.run(
                jq_argv,
                input=source,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=self.cwd,
                timeout=min(30, max(self.remaining_seconds(), 0.001)),
                check=False,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired, OSError) as error:
            return "error", str(error), {}
        if result.returncode == 0:
            status = "pass"
        elif result.returncode == 1:
            status = "fail"
        else:
            status = "error"
        feedback = "\n".join(
            part for part in [result.stdout.strip(), result.stderr.strip()] if part
        )
        return status, feedback, {
            "exit_code": result.returncode,
            "duration_seconds": round(time.monotonic() - started, 3),
        }

    def _judge_prompt(self, output: str, evidence: str) -> str:
        return f"""You are an independent evaluator in a blind jury.
Evaluate whether the candidate result adequately completes the original task.
The identity of the worker is intentionally hidden. Do not infer or mention it.
Do not assume another judge's vote. Use only the task, candidate result and evidence below.

Original task:
{truncate(self.original_prompt, self.feedback_max_chars)}

Candidate result:
{truncate(output, self.feedback_max_chars)}

Workspace evidence:
{evidence or "No workspace evidence was available."}

Return only one JSON object with this exact shape:
{{"verdict":"pass|fail|abstain","confidence":0.0,"failures":[],"repair_instructions":[]}}
Use pass only when the task is complete and supported by the evidence.
Use abstain when the available evidence is insufficient for a reliable decision.
"""

    def _arbiter_prompt(self, output: str, evidence: str, votes: list[Vote]) -> str:
        anonymous = [vote.anonymized() for vote in votes]
        return f"""You are the final arbiter for a blind evaluation with no valid majority.
The worker and judge identities are hidden. Decide from the task, result, evidence and anonymized votes.

Original task:
{truncate(self.original_prompt, self.feedback_max_chars)}

Candidate result:
{truncate(output, self.feedback_max_chars)}

Workspace evidence:
{evidence or "No workspace evidence was available."}

Anonymized votes:
{json.dumps(anonymous, ensure_ascii=False)}

Return only one JSON object with this exact shape:
{{"verdict":"pass|fail|abstain","confidence":0.0,"failures":[],"repair_instructions":[]}}
"""

    @staticmethod
    def _string_list(value: Any) -> list[str]:
        if not isinstance(value, list):
            return []
        return [item for item in value if isinstance(item, str) and item]

    def _parse_vote(self, output: str, threshold: float, judge_route: str) -> Vote:
        try:
            payload = parse_json_object(output)
            verdict = payload.get("verdict")
            confidence = payload.get("confidence")
            if verdict not in {"pass", "fail", "abstain"}:
                raise ValueError("verdict invalido")
            if not isinstance(confidence, (int, float)) or isinstance(confidence, bool):
                raise ValueError("confidence invalida")
            confidence_value = float(confidence)
            if confidence_value < 0 or confidence_value > 1:
                raise ValueError("confidence fora do intervalo 0..1")
            failures = self._string_list(payload.get("failures"))
            instructions = self._string_list(payload.get("repair_instructions"))
            if confidence_value < threshold:
                verdict = "abstain"
            return Vote(
                verdict,
                confidence_value,
                failures,
                instructions,
                judge_route,
                verdict in {"pass", "fail"},
            )
        except (ValueError, TypeError, json.JSONDecodeError):
            return Vote("abstain", 0.0, ["saida invalida do juiz"], [], judge_route, False)

    def _call_judge(
        self,
        judge_route: str,
        threshold: float,
        prompt: str,
        kind: str,
    ) -> Vote:
        if (
            self.judge_sessions >= self.max_judge_sessions
            or self.total_sessions >= self.max_total_sessions
            or self.deadline_reached()
        ):
            return Vote("abstain", 0.0, ["teto de sessoes do juri atingido"], [], judge_route, False)
        self.judge_sessions += 1
        self.total_sessions += 1
        result = self.execute_model(judge_route, "judge", prompt)
        if result.status == "success":
            vote = self._parse_vote(result.output, threshold, judge_route)
        else:
            vote = Vote(
                "abstain",
                0.0,
                [f"juiz indisponivel: {result.status}"],
                [],
                judge_route,
                False,
            )
        self.logger.write(
            "judge_finished",
            kind=kind,
            route=judge_route,
            status=result.status,
            verdict=vote.verdict,
            confidence=vote.confidence,
            duration_seconds=round(result.duration_seconds, 3),
        )
        return vote

    @staticmethod
    def _majority(votes: list[Vote], quorum: int) -> str | None:
        pass_count = sum(vote.valid and vote.verdict == "pass" for vote in votes)
        fail_count = sum(vote.valid and vote.verdict == "fail" for vote in votes)
        if pass_count >= quorum:
            return "pass"
        if fail_count >= quorum:
            return "fail"
        return None

    def _failure_feedback(
        self,
        votes: list[Vote],
        jury_config: dict[str, Any],
        arbiter_vote: Vote | None = None,
    ) -> str:
        if arbiter_vote and arbiter_vote.valid and arbiter_vote.verdict == "fail":
            return arbiter_vote.feedback()
        feedback_config = self._require_dict(jury_config.get("feedback", {}), "jury.feedback")
        preferred = feedback_config.get("preferred_route")
        if feedback_config.get("fallback", "majority_failures") != "majority_failures":
            raise ConfigError("jury.feedback.fallback precisa ser majority_failures")
        for vote in votes:
            if vote.judge_route == preferred and vote.valid and vote.verdict == "fail":
                return vote.feedback()
        parts = [vote.feedback() for vote in votes if vote.valid and vote.verdict == "fail"]
        return "\n".join(part for part in parts if part).strip()

    def verify_jury(
        self,
        jury_config: dict[str, Any],
        worker_route: str,
        output: str,
        evidence: str,
    ) -> VerificationResult:
        if jury_config.get("type") != "llm_jury":
            raise ConfigError("verificador de juri precisa ter type llm_jury")
        if jury_config.get("blind") is not True:
            raise ConfigError("o juri precisa declarar blind: true")
        if jury_config.get("evaluation") != "lazy_majority":
            raise ConfigError("o juri precisa usar evaluation: lazy_majority")
        judges = jury_config.get("judges")
        if not isinstance(judges, list) or len(judges) < 3:
            raise ConfigError("juri precisa declarar ao menos tres judges")
        quorum = self._positive_int(jury_config.get("quorum", 2), "jury.quorum")
        prompt = self._judge_prompt(output, evidence)
        votes: list[Vote] = []

        for judge in judges[:2]:
            judge_config = self._require_dict(judge, "jury.judges[]")
            route = self._require_string(judge_config.get("route"), "jury.judges[].route")
            threshold = self._positive_number(
                judge_config.get("threshold"), "jury.judges[].threshold"
            )
            if threshold > 1:
                raise ConfigError("jury threshold precisa estar entre 0 e 1")
            votes.append(self._call_judge(route, threshold, prompt, "judge"))

        decision = self._majority(votes, quorum)
        if decision is None:
            judge_config = self._require_dict(judges[2], "jury.judges[2]")
            route = self._require_string(judge_config.get("route"), "jury.judges[2].route")
            threshold = self._positive_number(
                judge_config.get("threshold"), "jury.judges[2].threshold"
            )
            if threshold > 1:
                raise ConfigError("jury threshold precisa estar entre 0 e 1")
            votes.append(self._call_judge(route, threshold, prompt, "judge"))
            decision = self._majority(votes, quorum)

        arbiter_vote: Vote | None = None
        if decision is None:
            arbiter = self._require_dict(jury_config.get("arbiter", {}), "jury.arbiter")
            preferred = self._require_string(
                arbiter.get("preferred_route"), "jury.arbiter.preferred_route"
            )
            fallback = self._require_string(
                arbiter.get("fallback_route"), "jury.arbiter.fallback_route"
            )
            arbiter_threshold = self._positive_number(
                arbiter.get("threshold"), "jury.arbiter.threshold"
            )
            if arbiter_threshold > 1:
                raise ConfigError("jury.arbiter.threshold precisa estar entre 0 e 1")
            avoid_worker = bool(arbiter.get("avoid_worker_route", True))
            candidates = [preferred, fallback]
            arbiter_route = next(
                (
                    route
                    for route in candidates
                    if route in self.routes and (not avoid_worker or route != worker_route)
                ),
                None,
            )
            if arbiter_route:
                arbiter_vote = self._call_judge(
                    arbiter_route,
                    arbiter_threshold,
                    self._arbiter_prompt(output, evidence, votes),
                    "arbiter",
                )
                if arbiter_vote.valid:
                    decision = arbiter_vote.verdict

        if decision == "pass":
            return VerificationResult("pass", details={"votes": len(votes)})
        if decision == "fail":
            feedback = self._failure_feedback(votes, jury_config, arbiter_vote)
            return VerificationResult(
                "fail",
                truncate(feedback or "o juri reprovou a tentativa", self.feedback_max_chars),
                {"votes": len(votes)},
            )
        return VerificationResult(
            "inconclusive",
            "o juri e o arbitro nao formaram decisao valida",
            {"votes": len(votes)},
        )

    def _verify_layered(
        self,
        verifier_name: str,
        verifier: dict[str, Any],
        worker_route: str,
        output: str,
        evidence: str,
        seen: set[str],
    ) -> VerificationResult:
        gates = verifier.get("gates", [])
        if not isinstance(gates, list):
            raise ConfigError(f"{verifier_name}.gates precisa ser uma lista")
        if not gates:
            fallback = self._require_string(verifier.get("fallback"), f"{verifier_name}.fallback")
            return self.verify(fallback, worker_route, output, evidence, seen)

        for index, raw_gate in enumerate(gates):
            gate = self._require_dict(raw_gate, f"{verifier_name}.gates[{index}]")
            gate_type = gate.get("type")
            if gate_type == "command":
                status, feedback, details = self._run_gate_command(gate)
            elif gate_type == "jq":
                status, feedback, details = self._run_gate_jq(gate, output, evidence)
            else:
                status, feedback, details = "error", f"tipo de gate desconhecido: {gate_type}", {}
            self.logger.write(
                "gate_finished",
                gate_index=index,
                gate_type=gate_type,
                selected_rule=gate.get("_selected_rule"),
                status=status,
                **details,
            )
            if status == "fail":
                return VerificationResult(
                    "fail",
                    truncate(feedback or f"gate {index} reprovou", self.feedback_max_chars),
                )
            if status == "error":
                policy = verifier.get("on_gate_error", "inconclusive")
                if policy in {"pass", "fail", "inconclusive"}:
                    return VerificationResult(policy, truncate(feedback, self.feedback_max_chars))
                if isinstance(policy, str) and policy in self.verifiers:
                    return self.verify(policy, worker_route, output, evidence, seen)
                raise ConfigError(f"on_gate_error invalido: {policy}")
        return VerificationResult("pass", details={"gates": len(gates)})

    def verify_auto_select(
        self,
        verifier: dict[str, Any],
        worker_route: str,
        output: str,
        evidence: str,
        seen: set[str],
    ) -> VerificationResult:
        gates, selected_rules, changed_files = self._select_auto_gates(verifier)
        fallback = self._require_string(verifier.get("fallback"), "auto_select.fallback")
        self.logger.write(
            "verifier_selected",
            verifier="auto_select",
            selected_rules=selected_rules,
            changed_files=changed_files,
            gate_count=len(gates),
            fallback=not gates,
        )
        if not gates:
            return self.verify(fallback, worker_route, output, evidence, seen)
        layered = {
            "type": "layered",
            "gates": gates,
            "fallback": fallback,
            "on_gate_error": verifier.get("on_gate_error", fallback),
        }
        result = self._verify_layered(
            "auto_select",
            layered,
            worker_route,
            output,
            evidence,
            seen,
        )
        result.details.update(
            {
                "selected_rules": selected_rules,
                "selected_gate_count": len(gates),
            }
        )
        return result

    def verify(
        self,
        verifier_name: str,
        worker_route: str,
        output: str,
        evidence: str,
        seen: set[str] | None = None,
    ) -> VerificationResult:
        if seen is None:
            seen = set()
        if verifier_name in seen:
            raise ConfigError(f"ciclo entre verificadores: {verifier_name}")
        seen = {*seen, verifier_name}
        verifier = self._require_dict(
            self.verifiers.get(verifier_name), f"auto.verifiers.{verifier_name}"
        )
        verifier_type = verifier.get("type")
        if verifier_type == "null":
            return VerificationResult("pass")
        if verifier_type == "llm_jury":
            return self.verify_jury(verifier, worker_route, output, evidence)
        if verifier_type == "auto_select":
            return self.verify_auto_select(verifier, worker_route, output, evidence, seen)
        if verifier_type != "layered":
            raise ConfigError(f"tipo de verificador desconhecido: {verifier_type}")
        return self._verify_layered(
            verifier_name,
            verifier,
            worker_route,
            output,
            evidence,
            seen,
        )

    def repair_prompt(self, previous_output: str, feedback: str) -> str:
        return f"""Complete the original task below by repairing the previous attempt.
Inspect and preserve useful work already present in the current workspace.
Address the process or verifier feedback directly. Do not restart without using the evidence.

Original task:
{self.original_prompt}

Previous result:
{truncate(previous_output or "No usable result was produced.", self.feedback_max_chars)}

Feedback:
{truncate(feedback or "The previous process did not complete successfully.", self.feedback_max_chars)}
"""

    def run(self) -> int:
        self.logger.write(
            "run_started",
            initial_route=self.initial_route,
            verifier=self.verifier_name,
            cwd=str(self.cwd),
            **content_metadata("prompt", self.original_prompt, self.logger.include_prompt),
        )
        self.logger.write(
            "route_selected",
            route=self.initial_route,
            ladder=self.ladder,
        )
        print(
            f"auto: verifier={self.verifier_name} ladder={' -> '.join(self.ladder)}",
            file=sys.stderr,
        )
        last_output = ""
        last_feedback = ""
        attempt_prompt = self.original_prompt
        last_worker_route: str | None = None
        escalations = 0
        workspace_baseline = self.capture_workspace_baseline()

        for route_name in self.ladder:
            retries_used = 0
            while True:
                if (
                    self.worker_attempts >= self.max_worker_attempts
                    or self.total_sessions >= self.max_total_sessions
                    or self.deadline_reached()
                ):
                    break
                if last_worker_route is not None and last_worker_route != route_name:
                    escalations += 1
                last_worker_route = route_name
                self.worker_attempts += 1
                self.total_sessions += 1
                print(
                    f"auto: tentativa {self.worker_attempts} com {route_name}",
                    file=sys.stderr,
                )
                process = self.execute_model(route_name, "worker", attempt_prompt)
                self.worker_changed_files = self.changes_since_baseline(workspace_baseline)
                if process.output:
                    last_output = process.output
                self.logger.write(
                    "worker_finished",
                    attempt=self.worker_attempts,
                    route=route_name,
                    status=process.status,
                    exit_code=process.exit_code,
                    duration_seconds=round(process.duration_seconds, 3),
                    escalations=escalations,
                    changed_files=self.worker_changed_files,
                    **content_metadata("output", process.output, self.logger.include_output),
                )

                if process.status != "success":
                    last_feedback = truncate(
                        "\n".join(
                            part
                            for part in [
                                f"worker terminou com status {process.status}",
                                process.stderr.strip(),
                            ]
                            if part
                        ),
                        self.feedback_max_chars,
                    )
                    if process.status in self.retry_on and retries_used < self.max_same_route_retries:
                        retries_used += 1
                        attempt_prompt = self.repair_prompt(last_output, last_feedback)
                        continue
                    break

                evidence = self.collect_evidence()
                verification = self.verify(
                    self.verifier_name,
                    route_name,
                    process.output,
                    evidence,
                )
                self.logger.write(
                    "verification_finished",
                    attempt=self.worker_attempts,
                    route=route_name,
                    verifier=self.verifier_name,
                    status=verification.status,
                    **verification.details,
                )
                if verification.status == "pass":
                    self.logger.write(
                        "run_finished",
                        status="pass",
                        final_route=route_name,
                        worker_attempts=self.worker_attempts,
                        judge_sessions=self.judge_sessions,
                        total_sessions=self.total_sessions,
                        escalations=escalations,
                        passed_first_attempt=self.worker_attempts == 1,
                        duration_seconds=round(time.monotonic() - self.started_at, 3),
                        **content_metadata("output", process.output, self.logger.include_output),
                    )
                    print(process.output)
                    print(
                        f"auto: aprovado por {self.verifier_name}; log={self.logger.path}",
                        file=sys.stderr,
                    )
                    return 0

                last_feedback = verification.feedback
                last_output = process.output
                if (
                    verification.status in self.retry_on
                    and retries_used < self.max_same_route_retries
                ):
                    retries_used += 1
                    attempt_prompt = self.repair_prompt(last_output, last_feedback)
                    continue
                break

            attempt_prompt = self.repair_prompt(last_output, last_feedback)
            if (
                self.worker_attempts >= self.max_worker_attempts
                or self.total_sessions >= self.max_total_sessions
                or self.deadline_reached()
            ):
                break

        final_status = "deadline" if self.deadline_reached() else "exhausted"
        self.logger.write(
            "run_finished",
            status=final_status,
            final_route=None,
            worker_attempts=self.worker_attempts,
            judge_sessions=self.judge_sessions,
            total_sessions=self.total_sessions,
            escalations=escalations,
            passed_first_attempt=False,
            duration_seconds=round(time.monotonic() - self.started_at, 3),
            **content_metadata("output", last_output, self.logger.include_output),
        )
        if last_output:
            print(last_output)
        print(
            f"auto: reprovado ({final_status}); log={self.logger.path}",
            file=sys.stderr,
        )
        return 1


def load_config(path: Path) -> dict[str, Any]:
    try:
        with path.open(encoding="utf-8") as stream:
            config = json.load(stream)
    except OSError as error:
        raise ConfigError(f"nao foi possivel ler config: {error}") from error
    except json.JSONDecodeError as error:
        raise ConfigError(f"config JSON invalido: {error}") from error
    if not isinstance(config, dict):
        raise ConfigError("config precisa ser um objeto JSON")
    return config


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Executa o model cascade headless")
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--route", required=True)
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--cwd", required=True, type=Path)
    parser.add_argument("--verifier")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        config_path = args.config.expanduser().resolve()
        cwd = args.cwd.expanduser().resolve()
        if not cwd.is_dir():
            raise ConfigError(f"cwd nao existe ou nao e diretorio: {cwd}")
        runner = AutoRunner(
            config_path,
            load_config(config_path),
            cwd,
            args.route,
            args.prompt,
            args.verifier,
        )
        return runner.run()
    except (ConfigError, OSError) as error:
        print(f"erro de configuracao: {error}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("auto: interrompido", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
