#!/usr/bin/env python3
"""Single-shot model executor used by the llm-router quality benchmark."""

from __future__ import annotations

import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any


ENV_PATTERN = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")
CLAUDE_MAX_EFFORT_PATTERN = re.compile(
    r"arquitet|architecture|architectural|produto|product|idea|ideia|brainstorm|"
    r"copy|venda|sales|marketing|rede social|social media|criativ|creative|roadmap|"
    r"planej|planning|design|spec|lan[cç]amento|launch",
    re.IGNORECASE,
)
CLAUDE_XHIGH_EFFORT_PATTERN = re.compile(
    r"discuss|debate|trade.?off|pr[oó]s e contras|"
    r"compare (?:op[cç][oõ]es|alternativas|abordagens)|policy|pol[ií]tica|argument|"
    r"falsific|open.?ended|decis[aã]o operacional",
    re.IGNORECASE,
)


class ConfigError(RuntimeError):
    """Raised when the benchmark executor configuration is invalid."""


@dataclass
class ProcessResult:
    status: str
    exit_code: int | None
    output: str
    stdout: str
    stderr: str
    duration_seconds: float


def expand_env_string(value: str) -> str:
    def replace(match: re.Match[str]) -> str:
        name = match.group(1)
        if name not in os.environ:
            raise ConfigError(f"missing required environment variable: {name}")
        return os.environ[name]

    return ENV_PATTERN.sub(replace, value)


def select_claude_effort(prompt: str) -> str:
    """Select Claude effort for one benchmark prompt."""
    if CLAUDE_MAX_EFFORT_PATTERN.search(prompt):
        return "max"
    if CLAUDE_XHIGH_EFFORT_PATTERN.search(prompt):
        return "xhigh"
    return "max"


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
    raise ValueError("output does not contain a valid JSON object")


def cleanup_temp_file(path: str | None) -> str | None:
    if not path or not os.path.exists(path):
        return None
    trash = shutil.which("trash")
    if not trash:
        return f"trash not found; temporary file preserved at {path}"
    result = subprocess.run(
        [trash, path],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or f"exit code {result.returncode}"
        return f"trash failed for {path}: {detail}"
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
            raise ValueError("claude_json output does not contain a textual result field")
        return result.strip()
    if output_format == "codex_last_message":
        if not output_file:
            raise ValueError("codex_last_message requires {output_file} in argv")
        try:
            return Path(output_file).read_text(encoding="utf-8").strip()
        except OSError as error:
            raise ValueError(
                f"could not read the final Codex message: {error}"
            ) from error
    raise ValueError(f"unknown output_format: {output_format}")


def load_config(path: Path) -> dict[str, Any]:
    try:
        with path.open(encoding="utf-8") as stream:
            config = json.load(stream)
    except OSError as error:
        raise ConfigError(f"could not read config: {error}") from error
    except json.JSONDecodeError as error:
        raise ConfigError(f"invalid JSON config: {error}") from error
    if not isinstance(config, dict):
        raise ConfigError("config must be a JSON object")
    return config


class BenchmarkExecutor:
    def __init__(self, config_path: Path, config: dict[str, Any], cwd: Path) -> None:
        self.config_path = config_path
        self.config = config
        self.cwd = cwd
        self.project_root = self._find_git_root(cwd) or cwd
        self.routes = self._load_routes(config.get("routes"))

    @staticmethod
    def _require_dict(value: Any, path: str) -> dict[str, Any]:
        if not isinstance(value, dict):
            raise ConfigError(f"{path} must be an object")
        return value

    @staticmethod
    def _require_string(value: Any, path: str) -> str:
        if not isinstance(value, str) or not value:
            raise ConfigError(f"{path} must be a non-empty string")
        return value

    @staticmethod
    def _positive_number(value: Any, path: str) -> float:
        if not isinstance(value, (int, float)) or isinstance(value, bool) or value <= 0:
            raise ConfigError(f"{path} must be a positive number")
        return float(value)

    @staticmethod
    def _load_routes(routes: Any) -> dict[str, dict[str, Any]]:
        if not isinstance(routes, list) or not routes:
            raise ConfigError("routes must be a non-empty list")
        result: dict[str, dict[str, Any]] = {}
        for route in routes:
            if not isinstance(route, dict):
                raise ConfigError("each routes item must be an object")
            name = route.get("name")
            if not isinstance(name, str) or not name:
                raise ConfigError("routes[].name must be a non-empty string")
            if name in result:
                raise ConfigError(f"duplicate route: {name}")
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

    def _configured_env(self, raw_env: Any, path: str) -> dict[str, str]:
        raw_env = self._require_dict(raw_env, path)
        env = os.environ.copy()
        for name, value in raw_env.items():
            if not isinstance(name, str) or not name:
                raise ConfigError(f"invalid name in {path}")
            if isinstance(value, str):
                env[name] = expand_env_string(value)
                continue
            if isinstance(value, dict) and isinstance(value.get("from_env"), str):
                source = value["from_env"]
                if source not in os.environ or not os.environ[source]:
                    raise ConfigError(f"missing required environment variable: {source}")
                env[name] = os.environ[source]
                continue
            raise ConfigError(f"invalid environment value for {name}")
        return env

    def _resolve_env(self, headless: dict[str, Any]) -> dict[str, str]:
        return self._configured_env(headless.get("env", {}), "routes[].headless.env")

    def _prepare_argv(
        self,
        raw_argv: Any,
        output_file: str | None,
        process_cwd: Path,
        runtime_values: dict[str, str] | None = None,
    ) -> list[str]:
        if not isinstance(raw_argv, list) or not raw_argv or not all(
            isinstance(item, str) for item in raw_argv
        ):
            raise ConfigError("headless.argv must be a non-empty list of strings")
        values = {
            "cwd": str(process_cwd),
            "project_root": str(self.project_root),
            "output_file": output_file or "",
        }
        if runtime_values:
            values.update(runtime_values)
        argv: list[str] = []
        for item in raw_argv:
            expanded = expand_env_string(item)
            for key, value in values.items():
                expanded = expanded.replace("{" + key + "}", value)
            argv.append(expanded)
        return argv

    @staticmethod
    def _profile_runtime_values(
        profile: dict[str, Any], role: str, prompt: str
    ) -> dict[str, str]:
        effort_policy = profile.get("effort_policy")
        if effort_policy is None:
            return {}
        if role != "worker":
            raise ConfigError("headless.effort_policy can only be used by the worker")
        if effort_policy != "claude_dynamic":
            raise ConfigError(f"unknown headless.effort_policy: {effort_policy}")
        return {"effort": select_claude_effort(prompt)}

    def execute_model(self, route_name: str, role: str, prompt: str) -> ProcessResult:
        started = time.monotonic()
        output_file: str | None = None
        try:
            if route_name not in self.routes:
                raise ConfigError(f"unknown route: {route_name}")
            route = self.routes[route_name]
            headless = self._require_dict(
                route.get("headless"), f"routes[{route_name}].headless"
            )
            profile = self._require_dict(
                headless.get(role), f"routes[{route_name}].headless.{role}"
            )
            timeout = self._positive_number(
                profile.get("timeout_seconds"),
                f"routes[{route_name}].headless.{role}.timeout_seconds",
            )
            raw_argv = profile.get("argv")
            needs_output_file = (
                profile.get("output_format") == "codex_last_message"
                or isinstance(raw_argv, list)
                and any("{output_file}" in str(item) for item in raw_argv)
            )
            if needs_output_file:
                if not shutil.which("trash"):
                    raise ConfigError(
                        "trash is required to clean up Codex temporary output"
                    )
                descriptor, output_file = tempfile.mkstemp(
                    prefix="llm-router-", suffix=".out"
                )
                os.close(descriptor)
            runtime_values = self._profile_runtime_values(profile, role, prompt)
            argv = self._prepare_argv(raw_argv, output_file, self.cwd, runtime_values)
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
                    self._require_string(
                        profile.get("output_format"), "headless.output_format"
                    ),
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
                print(f"warning: {cleanup_error}", file=sys.stderr)
