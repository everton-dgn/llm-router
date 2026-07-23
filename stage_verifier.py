#!/usr/bin/env python3
"""Deterministic, one-shot verification for routed execution stages."""

from __future__ import annotations

import argparse
import datetime as dt
import fnmatch
import hashlib
import json
import os
import re
import secrets
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any


BASELINE_ROOT_NAME = "llm-router-stage-baselines"
BASELINE_ID_PATTERN = re.compile(r"[0-9a-f]{32}")
BASELINE_FORMAT = "llm-router-stage-baseline"
BASELINE_VERSION = 1
BASELINE_CONSUMED_NAME = "consumed.json"
DEFAULT_LOG_PATH = Path(tempfile.gettempdir()) / "llm-router-stage-verifier.jsonl"
SUCCESS_STATUSES = {"prepared", "pass", "no_changes", "no_applicable_gates"}
SENSITIVE_SUFFIXES = {".pem", ".key", ".p12", ".pfx", ".crt"}
SENSITIVE_NAMES = {
    "credentials.json",
    "secrets.json",
    "id_rsa",
    "id_ed25519",
    ".npmrc",
    ".netrc",
}


class StageVerifierError(Exception):
    """An infrastructure or configuration error with a stable user message."""


def _require_object(value: Any, path: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise StageVerifierError(f"{path} must be an object")
    return value


def _require_string(value: Any, path: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise StageVerifierError(f"{path} must be a non-empty string")
    return value


def _string_list(value: Any, path: str) -> list[str]:
    if not isinstance(value, list) or not value or not all(
        isinstance(item, str) and item for item in value
    ):
        raise StageVerifierError(f"{path} must be a non-empty string list")
    return value


def _canonical_hash(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def _file_type(mode: int) -> str:
    if stat.S_ISREG(mode):
        return "file"
    if stat.S_ISDIR(mode):
        return "directory"
    if stat.S_ISLNK(mode):
        return "symlink"
    if stat.S_ISFIFO(mode):
        return "fifo"
    if stat.S_ISSOCK(mode):
        return "socket"
    if stat.S_ISCHR(mode):
        return "character_device"
    if stat.S_ISBLK(mode):
        return "block_device"
    return "other"


def _content_hash(path: Path, kind: str) -> str | None:
    digest = hashlib.sha256()
    if _is_sensitive_path(path):
        metadata = path.lstat()
        digest.update(
            f"metadata:{metadata.st_size}:{metadata.st_mtime_ns}:{metadata.st_ctime_ns}".encode(
                "ascii"
            )
        )
        return digest.hexdigest()
    if kind == "file":
        with path.open("rb") as stream:
            while chunk := stream.read(1024 * 1024):
                digest.update(chunk)
        return digest.hexdigest()
    if kind == "symlink":
        digest.update(os.readlink(path).encode("utf-8", errors="surrogateescape"))
        return digest.hexdigest()
    return None


def _is_sensitive_path(path: Path) -> bool:
    name = path.name.lower()
    parts = tuple(part.lower() for part in path.parts)
    if path.suffix.lower() in SENSITIVE_SUFFIXES or name in SENSITIVE_NAMES:
        return True
    if name.startswith("service_account") and name.endswith(".json"):
        return True
    return parts[-2:] in {
        (".ssh", "config"),
        (".aws", "credentials"),
        (".kube", "config"),
    }


def _missing_fingerprint() -> dict[str, Any]:
    descriptor = {"mode": None, "type": "missing", "content_sha256": None}
    return {**descriptor, "sha256": _canonical_hash(descriptor)}


def _working_fingerprint(path: Path) -> dict[str, Any]:
    if not path.exists() and not path.is_symlink():
        return _missing_fingerprint()
    try:
        metadata = path.lstat()
        kind = _file_type(metadata.st_mode)
        descriptor = {
            "mode": stat.S_IMODE(metadata.st_mode),
            "type": kind,
            "content_sha256": _content_hash(path, kind),
        }
    except OSError as error:
        raise StageVerifierError(f"cannot fingerprint {path}: {error}") from error
    return {**descriptor, "sha256": _canonical_hash(descriptor)}


def _run_git(project_root: Path, argv: list[str], *, binary: bool = False) -> str | bytes:
    try:
        result = subprocess.run(
            ["git", *argv],
            cwd=project_root,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=30,
            check=False,
            shell=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise StageVerifierError(f"git {' '.join(argv)} failed: {error}") from error
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise StageVerifierError(f"git {' '.join(argv)} failed: {detail or result.returncode}")
    if binary:
        return result.stdout
    return result.stdout.decode("utf-8", errors="surrogateescape")


def _require_git_root(project_root: Path) -> None:
    root = Path(str(_run_git(project_root, ["rev-parse", "--show-toplevel"])).strip()).resolve()
    if root != project_root:
        raise StageVerifierError(f"project_root must be the Git worktree root: {root}")


def _git_head(project_root: Path) -> str:
    head = str(_run_git(project_root, ["rev-parse", "--verify", "HEAD"])).strip()
    if not re.fullmatch(r"[0-9a-fA-F]{40,64}", head):
        raise StageVerifierError("Git repository has no valid HEAD commit")
    return head


def _git_paths(project_root: Path, argv: list[str]) -> set[str]:
    raw = _run_git(project_root, argv, binary=True)
    assert isinstance(raw, bytes)
    return {
        item.decode("utf-8", errors="surrogateescape")
        for item in raw.split(b"\0")
        if item
    }


def _dirty_paths(project_root: Path) -> set[str]:
    tracked = _git_paths(
        project_root,
        ["diff", "--name-only", "--no-renames", "--relative", "-z", "HEAD", "--"],
    )
    untracked = _git_paths(
        project_root,
        ["ls-files", "--others", "--exclude-standard", "-z", "--"],
    )
    return tracked | untracked


def _workspace_path(project_root: Path, relative: str) -> Path:
    candidate = Path(relative)
    if candidate.is_absolute() or ".." in candidate.parts or relative in {"", "."}:
        raise StageVerifierError(f"invalid Git path: {relative!r}")
    return project_root / candidate


def _head_fingerprint(project_root: Path, head: str, relative: str) -> dict[str, Any]:
    raw = _run_git(project_root, ["ls-tree", "-z", head, "--", relative], binary=True)
    assert isinstance(raw, bytes)
    if not raw:
        return _missing_fingerprint()
    record = raw.split(b"\0", 1)[0]
    try:
        metadata, tree_path = record.split(b"\t", 1)
        mode_raw, object_type_raw, object_id_raw = metadata.split(b" ", 2)
    except ValueError as error:
        raise StageVerifierError(f"invalid Git tree record for {relative}") from error
    tree_relative = tree_path.decode("utf-8", errors="surrogateescape")
    if tree_relative != relative:
        raise StageVerifierError(f"ambiguous Git tree record for {relative}")
    mode_text = mode_raw.decode("ascii")
    object_type = object_type_raw.decode("ascii")
    object_id = object_id_raw.decode("ascii")
    if mode_text == "120000":
        kind = "symlink"
        mode = 0o777
    elif mode_text == "160000":
        kind = "submodule"
        mode = 0
    elif object_type == "tree":
        kind = "directory"
        mode = 0o755
    else:
        kind = "file"
        mode = int(mode_text[-3:], 8)
    if object_type == "blob" and _is_sensitive_path(Path(relative)):
        content_sha256 = hashlib.sha256(f"git-object:{object_id}".encode("ascii")).hexdigest()
    elif object_type == "blob":
        content = _run_git(project_root, ["cat-file", "blob", object_id], binary=True)
        assert isinstance(content, bytes)
        content_sha256 = hashlib.sha256(content).hexdigest()
    else:
        content_sha256 = hashlib.sha256(object_id.encode("ascii")).hexdigest()
    descriptor = {"mode": mode, "type": kind, "content_sha256": content_sha256}
    return {**descriptor, "sha256": _canonical_hash(descriptor)}


def _changes_since_baseline(
    project_root: Path,
    baseline_head: str,
    initial_dirty: dict[str, dict[str, Any]],
    excluded: set[str],
) -> tuple[list[str], str]:
    current_head = _git_head(project_root)
    final_dirty = _dirty_paths(project_root) - excluded
    committed = (
        _git_paths(
            project_root,
            [
                "diff",
                "--name-only",
                "--no-renames",
                "--relative",
                "-z",
                baseline_head,
                current_head,
                "--",
            ],
        )
        if current_head != baseline_head
        else set()
    )
    committed -= excluded
    candidates = set(initial_dirty) | final_dirty | committed
    changed: list[str] = []
    for relative in sorted(candidates):
        before = initial_dirty.get(relative)
        if before is None:
            before = _head_fingerprint(project_root, baseline_head, relative)
        after = _working_fingerprint(_workspace_path(project_root, relative))
        if before.get("sha256") != after.get("sha256"):
            changed.append(relative)
    return changed, current_head


def _verification_state(
    project_root: Path, excluded: set[str]
) -> dict[str, Any]:
    dirty_paths = _dirty_paths(project_root) - excluded
    index = _run_git(project_root, ["ls-files", "--stage", "-z"], binary=True)
    assert isinstance(index, bytes)
    return {
        "head": _git_head(project_root),
        "index_sha256": hashlib.sha256(index).hexdigest(),
        "working": {
            relative: _working_fingerprint(_workspace_path(project_root, relative))["sha256"]
            for relative in sorted(dirty_paths)
        },
    }


def _resolve_path(value: Any, base: Path, field: str) -> Path:
    raw = _require_string(value, field)
    expanded = Path(os.path.expandvars(os.path.expanduser(raw)))
    return (expanded if expanded.is_absolute() else base / expanded).resolve()


def _log_path(request: dict[str, Any], project_root: Path) -> Path:
    raw = request.get("log_path")
    if raw is None:
        return DEFAULT_LOG_PATH.resolve()
    return _resolve_path(raw, project_root, "log_path")


def _log_exclusions(project_root: Path, log_path: Path) -> set[str]:
    try:
        return {log_path.relative_to(project_root).as_posix()}
    except ValueError:
        return set()


def _sanitize_log(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: _sanitize_log(item)
            for key, item in value.items()
            if "prompt" not in key.lower()
        }
    if isinstance(value, list):
        return [_sanitize_log(item) for item in value]
    return value


def _write_log(log_path: Path, event: str, **fields: Any) -> None:
    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        record = _sanitize_log(
            {
                "timestamp": dt.datetime.now(dt.timezone.utc).isoformat(),
                "event": event,
                **fields,
            }
        )
        with log_path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(record, sort_keys=True, ensure_ascii=False) + "\n")
    except OSError as error:
        raise StageVerifierError(f"cannot write JSONL log {log_path}: {error}") from error


def _baseline_root() -> Path:
    root = Path(tempfile.gettempdir()).resolve() / BASELINE_ROOT_NAME
    try:
        if not root.exists():
            root.mkdir(mode=0o700, exist_ok=True)
        metadata = root.lstat()
        if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
            raise StageVerifierError(f"baseline root is not a secure directory: {root}")
        if hasattr(os, "getuid") and metadata.st_uid != os.getuid():
            raise StageVerifierError(f"baseline root has a different owner: {root}")
        if stat.S_IMODE(metadata.st_mode) != 0o700:
            root.chmod(0o700)
    except OSError as error:
        raise StageVerifierError(f"cannot secure baseline root {root}: {error}") from error
    return root


def _baseline_directory(baseline_id: str) -> Path:
    if not BASELINE_ID_PATTERN.fullmatch(baseline_id):
        raise StageVerifierError("baseline_id must be 32 lowercase hexadecimal characters")
    return _baseline_root() / baseline_id


def _write_baseline(payload: dict[str, Any], baseline_id: str) -> None:
    directory = _baseline_directory(baseline_id)
    path = directory / "baseline.json"
    try:
        directory.mkdir(mode=0o700)
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, sort_keys=True)
    except OSError as error:
        raise StageVerifierError(f"cannot write baseline {path}: {error}") from error


def _load_and_consume_baseline(id_value: Any) -> dict[str, Any]:
    baseline_id = _require_string(id_value, "baseline_id")
    directory = _baseline_directory(baseline_id)
    path = directory / "baseline.json"
    consumed_path = directory / BASELINE_CONSUMED_NAME
    try:
        directory_metadata = directory.lstat()
        if not stat.S_ISDIR(directory_metadata.st_mode) or stat.S_ISLNK(directory_metadata.st_mode):
            raise StageVerifierError("baseline directory is not secure")
        if stat.S_IMODE(directory_metadata.st_mode) != 0o700:
            raise StageVerifierError("baseline directory mode must be 0700")
        if hasattr(os, "getuid") and directory_metadata.st_uid != os.getuid():
            raise StageVerifierError("baseline has a different owner")
        try:
            consumed_path.lstat()
        except FileNotFoundError:
            pass
        else:
            raise StageVerifierError("baseline is missing or was already consumed")
        file_metadata = path.lstat()
        if not stat.S_ISREG(file_metadata.st_mode) or stat.S_ISLNK(file_metadata.st_mode):
            raise StageVerifierError("baseline file is not a regular file")
        if stat.S_IMODE(file_metadata.st_mode) != 0o600:
            raise StageVerifierError("baseline file mode must be 0600")
        if hasattr(os, "getuid") and file_metadata.st_uid != os.getuid():
            raise StageVerifierError("baseline has a different owner")
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise StageVerifierError("baseline is missing or was already consumed") from error
    except (OSError, json.JSONDecodeError) as error:
        raise StageVerifierError(f"cannot read baseline: {error}") from error
    baseline = _require_object(payload, "baseline")
    if baseline.get("format") != BASELINE_FORMAT or baseline.get("version") != BASELINE_VERSION:
        raise StageVerifierError("unsupported baseline format")
    if baseline.get("baseline_id") != baseline_id:
        raise StageVerifierError("baseline_id does not match the stored baseline")
    try:
        descriptor = os.open(
            consumed_path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            0o600,
        )
    except FileExistsError as error:
        raise StageVerifierError("baseline is missing or was already consumed") from error
    except OSError as error:
        raise StageVerifierError(f"cannot consume baseline: {error}") from error
    try:
        os.close(descriptor)
    except OSError as error:
        raise StageVerifierError(f"cannot record baseline consumption: {error}") from error
    return baseline


def prepare(request: dict[str, Any]) -> dict[str, Any]:
    request = _require_object(request, "request")
    unknown = sorted(set(request) - {"project_root", "config_path", "log_path"})
    if unknown:
        raise StageVerifierError(f"unknown prepare fields: {', '.join(unknown)}")
    project_root = _resolve_path(request.get("project_root"), Path.cwd(), "project_root")
    if not project_root.is_dir():
        raise StageVerifierError(f"project_root is not a directory: {project_root}")
    _require_git_root(project_root)
    head = _git_head(project_root)
    config_path = _resolve_path(
        request.get("config_path", str(project_root / "config.json")),
        project_root,
        "config_path",
    )
    log_path = _log_path(request, project_root)
    excluded = _log_exclusions(project_root, log_path)
    dirty_paths = _dirty_paths(project_root) - excluded
    dirty_fingerprints = {
        relative: _working_fingerprint(_workspace_path(project_root, relative))
        for relative in sorted(dirty_paths)
    }
    baseline_id = secrets.token_hex(16)
    baseline = {
        "format": BASELINE_FORMAT,
        "version": BASELINE_VERSION,
        "baseline_id": baseline_id,
        "project_root": str(project_root),
        "head": head,
        "config_path": str(config_path),
        "log_path": str(log_path),
        "excluded_paths": sorted(excluded),
        "dirty_fingerprints": dirty_fingerprints,
    }
    _write_baseline(baseline, baseline_id)
    _write_log(
        log_path,
        "baseline_prepared",
        baseline_id=baseline_id,
        head=head,
        dirty_path_count=len(dirty_fingerprints),
    )
    return {
        "status": "prepared",
        "baseline_id": baseline_id,
        "head": head,
        "dirty_path_count": len(dirty_fingerprints),
        "log_path": str(log_path),
    }


def _json_key_exists(payload: Any, dotted_key: str) -> bool:
    current = payload
    for part in dotted_key.split("."):
        if not isinstance(current, dict) or part not in current:
            return False
        current = current[part]
    if current is None:
        return False
    return not isinstance(current, str) or bool(current.strip())


def _json_keys_match(project_root: Path, specs: Any, path: str) -> bool:
    if not isinstance(specs, list) or not specs:
        raise StageVerifierError(f"{path} must be a non-empty list")
    for index, raw_spec in enumerate(specs):
        spec = _require_object(raw_spec, f"{path}[{index}]")
        relative = _require_string(spec.get("path"), f"{path}[{index}].path")
        keys = _string_list(spec.get("keys"), f"{path}[{index}].keys")
        try:
            payload = json.loads((project_root / relative).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return False
        if not all(_json_key_exists(payload, key) for key in keys):
            return False
    return True


def _rule_matches(
    rule: dict[str, Any],
    project_root: Path,
    changed_files: list[str],
    path: str,
) -> bool:
    match = _require_object(rule.get("match", {}), f"{path}.match")
    allowed = {"files_all", "files_any", "changed_any", "commands_all", "json_keys_all"}
    unknown = sorted(set(match) - allowed)
    if unknown:
        raise StageVerifierError(f"unknown keys in {path}.match: {', '.join(unknown)}")
    if "files_all" in match:
        values = _string_list(match["files_all"], f"{path}.match.files_all")
        if not all((project_root / item).exists() for item in values):
            return False
    if "files_any" in match:
        values = _string_list(match["files_any"], f"{path}.match.files_any")
        if not any((project_root / item).exists() for item in values):
            return False
    if "changed_any" in match:
        patterns = _string_list(match["changed_any"], f"{path}.match.changed_any")
        if not any(fnmatch.fnmatch(item, pattern) for item in changed_files for pattern in patterns):
            return False
    if "commands_all" in match:
        commands = _string_list(match["commands_all"], f"{path}.match.commands_all")
        if not all(shutil.which(command) for command in commands):
            return False
    if "json_keys_all" in match and not _json_keys_match(
        project_root, match["json_keys_all"], f"{path}.match.json_keys_all"
    ):
        return False
    return True


def _load_verification_config(config_path: Path) -> tuple[list[dict[str, Any]], int]:
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise StageVerifierError(f"cannot read config {config_path}: {error}") from error
    root = _require_object(config, "config")
    verification = _require_object(root.get("verification"), "config.verification")
    evidence_max_chars = verification.get("evidence_max_chars", 30000)
    if (
        isinstance(evidence_max_chars, bool)
        or not isinstance(evidence_max_chars, int)
        or evidence_max_chars <= 0
    ):
        raise StageVerifierError("config.verification.evidence_max_chars must be a positive integer")
    raw_rules = verification.get("rules")
    if not isinstance(raw_rules, list):
        raise StageVerifierError("config.verification.rules must be a list")
    rules: list[dict[str, Any]] = []
    names: set[str] = set()
    for index, raw_rule in enumerate(raw_rules):
        rule = _require_object(raw_rule, f"config.verification.rules[{index}]")
        name = _require_string(rule.get("name"), f"config.verification.rules[{index}].name")
        if name in names:
            raise StageVerifierError(f"duplicate verification rule: {name}")
        names.add(name)
        gates = rule.get("gates")
        if not isinstance(gates, list) or not gates:
            raise StageVerifierError(f"config.verification.rules[{index}].gates must be non-empty")
        rules.append(rule)
    return rules, evidence_max_chars


def _select_gates(
    rules: list[dict[str, Any]], project_root: Path, changed_files: list[str]
) -> tuple[list[dict[str, Any]], list[str]]:
    selected_rules: list[str] = []
    selected_gates: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, rule in enumerate(rules):
        path = f"config.verification.rules[{index}]"
        if not _rule_matches(rule, project_root, changed_files, path):
            continue
        name = str(rule["name"])
        selected_rules.append(name)
        for raw_gate in rule["gates"]:
            gate = _require_object(raw_gate, f"{path}.gates[]").copy()
            key = json.dumps(gate, sort_keys=True, separators=(",", ":"))
            if key in seen:
                continue
            seen.add(key)
            gate["selected_rule"] = name
            selected_gates.append(gate)
    return selected_gates, selected_rules


def _stop_process(process: subprocess.Popen[str]) -> tuple[str, str]:
    try:
        if os.name == "posix":
            os.killpg(process.pid, signal.SIGTERM)
        else:
            process.terminate()
        return process.communicate(timeout=2)
    except subprocess.TimeoutExpired:
        if os.name == "posix":
            os.killpg(process.pid, signal.SIGKILL)
        else:
            process.kill()
        return process.communicate()


def _run_command_gate(
    gate: dict[str, Any], project_root: Path, changed_files: list[str]
) -> dict[str, Any]:
    started = time.monotonic()
    if gate.get("type") != "command":
        raise StageVerifierError("verification gates must use type=command")
    untrusted_patterns = gate.get("untrusted_if_changed", [])
    if untrusted_patterns:
        patterns = _string_list(untrusted_patterns, "command gate untrusted_if_changed")
        untrusted = sorted(
            item
            for item in changed_files
            if any(fnmatch.fnmatch(item, pattern) for pattern in patterns)
        )
        if untrusted:
            return {
                "status": "infrastructure_error",
                "exit_code": None,
                "duration_seconds": round(time.monotonic() - started, 3),
                "stdout": "",
                "stderr": "gate inputs changed during the stage: " + ", ".join(untrusted),
            }
    argv = gate.get("argv")
    if not isinstance(argv, list) or not argv or not all(
        isinstance(item, str) and item for item in argv
    ):
        raise StageVerifierError("command gate argv must be a non-empty string list")
    timeout = gate.get("timeout_seconds", 300)
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or timeout <= 0:
        raise StageVerifierError("command gate timeout_seconds must be positive")
    error_codes = gate.get("error_exit_codes", [])
    if not isinstance(error_codes, list) or not all(
        isinstance(code, int) and not isinstance(code, bool) for code in error_codes
    ):
        raise StageVerifierError("command gate error_exit_codes must be an integer list")
    cwd_raw = gate.get("cwd", "{project_root}")
    cwd_text = _require_string(cwd_raw, "command gate cwd")
    cwd_text = os.path.expandvars(os.path.expanduser(cwd_text)).replace(
        "{project_root}", str(project_root)
    )
    cwd = Path(cwd_text)
    if not cwd.is_absolute():
        cwd = project_root / cwd
    cwd = cwd.resolve()
    if not cwd.is_dir():
        raise StageVerifierError(f"command gate cwd is not a directory: {cwd}")
    raw_env = _require_object(gate.get("env", {}), "command gate env")
    if not all(isinstance(key, str) and isinstance(value, str) for key, value in raw_env.items()):
        raise StageVerifierError("command gate env must contain string keys and values")
    env = os.environ.copy()
    env.update({key: os.path.expandvars(value) for key, value in raw_env.items()})
    try:
        process = subprocess.Popen(
            argv,
            cwd=cwd,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
            shell=False,
        )
        try:
            stdout, stderr = process.communicate(timeout=float(timeout))
            timed_out = False
        except subprocess.TimeoutExpired:
            stdout, stderr = _stop_process(process)
            timed_out = True
    except OSError as error:
        return {
            "status": "infrastructure_error",
            "exit_code": None,
            "duration_seconds": round(time.monotonic() - started, 3),
            "stdout": "",
            "stderr": str(error),
        }
    if timed_out:
        status_value = "infrastructure_error"
        stderr = f"gate timed out after {timeout} seconds\n{stderr}".strip()
    elif process.returncode == 0:
        status_value = "pass"
    elif process.returncode in error_codes:
        status_value = "infrastructure_error"
    else:
        status_value = "fail"
    return {
        "status": status_value,
        "exit_code": process.returncode,
        "duration_seconds": round(time.monotonic() - started, 3),
        "stdout": stdout[-20000:],
        "stderr": stderr[-20000:],
    }


def _limit_evidence(gates: list[dict[str, Any]], limit: int) -> None:
    remaining = limit
    for gate in gates:
        fields = ("stderr", "stdout") if gate.get("status") != "pass" else ("stdout", "stderr")
        for field in fields:
            value = gate.get(field, "")
            if not isinstance(value, str):
                continue
            gate[field] = value[:remaining]
            remaining = max(0, remaining - len(gate[field]))


def verify(request: dict[str, Any]) -> dict[str, Any]:
    request = _require_object(request, "request")
    unknown = sorted(set(request) - {"baseline_id"})
    if unknown:
        raise StageVerifierError(f"verify accepts only baseline_id; unknown fields: {', '.join(unknown)}")
    baseline = _load_and_consume_baseline(request.get("baseline_id"))
    project_root = Path(_require_string(baseline.get("project_root"), "baseline.project_root"))
    config_path = Path(_require_string(baseline.get("config_path"), "baseline.config_path"))
    log_path = Path(_require_string(baseline.get("log_path"), "baseline.log_path"))
    _require_git_root(project_root)
    baseline_head = _require_string(baseline.get("head"), "baseline.head")
    dirty_fingerprints = _require_object(
        baseline.get("dirty_fingerprints"), "baseline.dirty_fingerprints"
    )
    excluded_raw = baseline.get("excluded_paths", [])
    if not isinstance(excluded_raw, list) or not all(isinstance(item, str) for item in excluded_raw):
        raise StageVerifierError("baseline.excluded_paths must be a string list")
    changed_files, current_head = _changes_since_baseline(
        project_root,
        baseline_head,
        dirty_fingerprints,
        set(excluded_raw),
    )
    baseline_id = baseline.get("baseline_id")
    head_changed = current_head != baseline_head
    if not changed_files and not head_changed:
        result = {
            "status": "no_changes",
            "baseline_id": baseline_id,
            "changed_files": [],
            "selected_rules": [],
            "gates": [],
            "head_changed": False,
        }
        _write_log(
            log_path,
            "verification_finished",
            status=result["status"],
            baseline_id=baseline_id,
            head=current_head,
            changed_files=[],
            selected_rules=[],
            gate_count=0,
        )
        return result
    rules, evidence_max_chars = _load_verification_config(config_path)
    gates, selected_rules = _select_gates(rules, project_root, changed_files)
    if not gates and not head_changed:
        result = {
            "status": "no_applicable_gates",
            "baseline_id": baseline_id,
            "changed_files": changed_files,
            "selected_rules": selected_rules,
            "gates": [],
            "head_changed": False,
        }
        _write_log(
            log_path,
            "verification_finished",
            status=result["status"],
            baseline_id=baseline_id,
            head=current_head,
            changed_files=changed_files,
            selected_rules=selected_rules,
            gate_count=0,
        )
        return result
    gate_results: list[dict[str, Any]] = []
    if head_changed:
        head_result = {
            "status": "fail",
            "exit_code": None,
            "duration_seconds": 0.0,
            "stdout": "",
            "stderr": f"HEAD changed during the stage: {baseline_head} -> {current_head}",
            "index": 0,
            "selected_rule": "git-head-integrity",
            "argv": None,
        }
        gate_results.append(head_result)
        _write_log(
            log_path,
            "gate_finished",
            baseline_id=baseline_id,
            head=current_head,
            index=head_result["index"],
            selected_rule=head_result["selected_rule"],
            status=head_result["status"],
            exit_code=head_result["exit_code"],
            duration_seconds=head_result["duration_seconds"],
        )
    pre_gate_state = _verification_state(project_root, set(excluded_raw))
    for gate in gates:
        try:
            gate_result = _run_command_gate(gate, project_root, changed_files)
        except StageVerifierError as error:
            gate_result = {
                "status": "infrastructure_error",
                "exit_code": None,
                "duration_seconds": 0.0,
                "stdout": "",
                "stderr": str(error),
            }
        gate_result.update(
            {
                "index": len(gate_results),
                "selected_rule": gate.get("selected_rule"),
                "argv": gate.get("argv"),
            }
        )
        gate_results.append(gate_result)
        _write_log(
            log_path,
            "gate_finished",
            baseline_id=baseline_id,
            head=current_head,
            index=gate_result["index"],
            selected_rule=gate.get("selected_rule"),
            status=gate_result["status"],
            exit_code=gate_result["exit_code"],
            duration_seconds=gate_result["duration_seconds"],
        )
    post_gate_state = _verification_state(project_root, set(excluded_raw))
    post_gate_files, post_gate_head = _changes_since_baseline(
        project_root,
        baseline_head,
        dirty_fingerprints,
        set(excluded_raw),
    )
    if post_gate_state != pre_gate_state:
        before_working = pre_gate_state["working"]
        after_working = post_gate_state["working"]
        before_files = set(before_working)
        after_files = set(after_working)
        rewritten = sorted(
            relative
            for relative in before_files & after_files
            if before_working[relative] != after_working[relative]
        )
        integrity_result = {
            "status": "infrastructure_error",
            "exit_code": None,
            "duration_seconds": 0.0,
            "stdout": "",
            "stderr": (
                "verification gates changed the worktree; "
                f"added delta paths: {', '.join(sorted(after_files - before_files)) or 'none'}; "
                f"removed delta paths: {', '.join(sorted(before_files - after_files)) or 'none'}; "
                f"rewritten delta paths: {', '.join(rewritten) or 'none'}; "
                f"index changed: {post_gate_state['index_sha256'] != pre_gate_state['index_sha256']}; "
                f"head changed: {post_gate_state['head'] != pre_gate_state['head']}"
            ),
            "index": len(gate_results),
            "selected_rule": "verification-integrity",
            "argv": None,
        }
        gate_results.append(integrity_result)
        _write_log(
            log_path,
            "gate_finished",
            baseline_id=baseline_id,
            head=post_gate_head,
            index=integrity_result["index"],
            selected_rule=integrity_result["selected_rule"],
            status=integrity_result["status"],
            exit_code=integrity_result["exit_code"],
            duration_seconds=integrity_result["duration_seconds"],
        )
        changed_files = post_gate_files
        current_head = post_gate_head
        head_changed = current_head != baseline_head
    statuses = {gate["status"] for gate in gate_results}
    if "infrastructure_error" in statuses:
        final_status = "infrastructure_error"
    elif "fail" in statuses:
        final_status = "fail"
    else:
        final_status = "pass"
    _limit_evidence(gate_results, evidence_max_chars)
    result = {
        "status": final_status,
        "baseline_id": baseline_id,
        "changed_files": changed_files,
        "selected_rules": selected_rules,
        "gates": gate_results,
        "head_changed": head_changed,
    }
    _write_log(
        log_path,
        "verification_finished",
        status=final_status,
        baseline_id=baseline_id,
        head=current_head,
        changed_files=changed_files,
        selected_rules=selected_rules,
        gate_count=len(gate_results),
    )
    return result


def _read_request(input_path: str) -> dict[str, Any]:
    try:
        if input_path == "-":
            payload = json.load(sys.stdin)
        else:
            payload = json.loads(Path(input_path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise StageVerifierError(f"cannot read JSON request: {error}") from error
    return _require_object(payload, "request")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("prepare", "verify"))
    parser.add_argument("--input", default="-", help="JSON request file, or - for stdin")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        request = _read_request(args.input)
        result = prepare(request) if args.command == "prepare" else verify(request)
    except StageVerifierError as error:
        result = {"status": "infrastructure_error", "error": str(error)}
    json.dump(result, sys.stdout, sort_keys=True, ensure_ascii=False)
    sys.stdout.write("\n")
    if result["status"] in SUCCESS_STATUSES:
        return 0
    return 1 if result["status"] == "fail" else 2


if __name__ == "__main__":
    raise SystemExit(main())
