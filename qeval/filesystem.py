"""Fixtures, snapshots, auditoria de arquivos e descarte temporário."""

from __future__ import annotations

import fnmatch
import hashlib
import os
import shutil
import stat
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from qeval import constants
from qeval.errors import EvaluationError


def trash_directory(path: Path) -> str | None:
    temp_root = Path(tempfile.gettempdir()).resolve()
    try:
        resolved = path.resolve(strict=True)
    except OSError as error:
        return f"diretório temporário inválido: {error}"
    if (
        not path.is_absolute()
        or not resolved.is_relative_to(temp_root)
        or not resolved.name.startswith(constants.TEMP_PREFIX)
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
            snapshot[relative] = f"{constants.UNSAFE_SNAPSHOT_PREFIX}lstat:{type(error).__name__}"
            continue
        if stat.S_ISDIR(metadata.st_mode):
            continue
        if stat.S_ISLNK(metadata.st_mode):
            try:
                link_target = os.readlink(target).encode("utf-8")
            except OSError as error:
                snapshot[relative] = (
                    f"{constants.UNSAFE_SNAPSHOT_PREFIX}readlink:{type(error).__name__}"
                )
                continue
            snapshot[relative] = (
                "symlink:" + hashlib.sha256(link_target).hexdigest()
            )
            continue
        elif stat.S_ISREG(metadata.st_mode):
            if metadata.st_size > constants.MAX_SNAPSHOT_FILE_BYTES:
                snapshot[relative] = (
                    f"{constants.UNSAFE_SNAPSHOT_PREFIX}file_size:{metadata.st_size}"
                )
                continue
            if total_bytes + metadata.st_size > constants.MAX_SNAPSHOT_TOTAL_BYTES:
                snapshot[relative] = (
                    f"{constants.UNSAFE_SNAPSHOT_PREFIX}total_size:{metadata.st_size}"
                )
                continue
        else:
            file_type = stat.S_IFMT(metadata.st_mode)
            snapshot[relative] = f"{constants.UNSAFE_SNAPSHOT_PREFIX}special:{file_type}"
            continue

        flags = os.O_RDONLY | getattr(os, "O_NONBLOCK", 0)
        flags |= getattr(os, "O_NOFOLLOW", 0)
        try:
            descriptor = os.open(target, flags)
        except OSError as error:
            snapshot[relative] = f"{constants.UNSAFE_SNAPSHOT_PREFIX}open:{type(error).__name__}"
            continue
        try:
            opened_metadata = os.fstat(descriptor)
            if not stat.S_ISREG(opened_metadata.st_mode):
                snapshot[relative] = (
                    f"{constants.UNSAFE_SNAPSHOT_PREFIX}type_changed:"
                    f"{stat.S_IFMT(opened_metadata.st_mode)}"
                )
                continue
            if opened_metadata.st_size > constants.MAX_SNAPSHOT_FILE_BYTES:
                snapshot[relative] = (
                    f"{constants.UNSAFE_SNAPSHOT_PREFIX}file_size:{opened_metadata.st_size}"
                )
                continue
            if total_bytes + opened_metadata.st_size > constants.MAX_SNAPSHOT_TOTAL_BYTES:
                snapshot[relative] = (
                    f"{constants.UNSAFE_SNAPSHOT_PREFIX}total_size:{opened_metadata.st_size}"
                )
                continue
            digest = hashlib.sha256()
            observed_bytes = 0
            while True:
                chunk = os.read(descriptor, constants.SNAPSHOT_CHUNK_BYTES)
                if not chunk:
                    break
                observed_bytes += len(chunk)
                if observed_bytes > constants.MAX_SNAPSHOT_FILE_BYTES:
                    snapshot[relative] = (
                        f"{constants.UNSAFE_SNAPSHOT_PREFIX}file_grew:{observed_bytes}"
                    )
                    break
                digest.update(chunk)
            if relative in snapshot:
                continue
            if total_bytes + observed_bytes > constants.MAX_SNAPSHOT_TOTAL_BYTES:
                snapshot[relative] = (
                    f"{constants.UNSAFE_SNAPSHOT_PREFIX}total_size:"
                    f"{total_bytes + observed_bytes}"
                )
                continue
            total_bytes += observed_bytes
            snapshot[relative] = "regular:" + digest.hexdigest()
        except OSError as error:
            snapshot[relative] = f"{constants.UNSAFE_SNAPSHOT_PREFIX}read:{type(error).__name__}"
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
        if digest.startswith(constants.UNSAFE_SNAPSHOT_PREFIX) or digest.startswith("symlink:")
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
