"""Sandbox: perfil, leitura segura, execução Python, behavior, mutantes e AST guard."""

from __future__ import annotations

import ast
import hashlib
import json
import os
import shutil
import stat
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from qeval import constants, runners
from qeval.errors import EvaluationError
from qeval.textutil import _sha256_json
from qeval.validation import _safe_relative_path, _safe_python_symbol_path


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
    python = constants.SANDBOX_PYTHON
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
    payload = assertion["argv"][len(constants.SANDBOXED_COMMAND_PREFIX) :]
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
        if metadata.st_size > constants.MAX_SNAPSHOT_FILE_BYTES:
            raise EvaluationError(
                f"arquivo excede o limite de {constants.MAX_SNAPSHOT_FILE_BYTES} bytes: {normalized}"
            )
        chunks: list[bytes] = []
        observed_bytes = 0
        while True:
            chunk = os.read(file_descriptor, constants.SNAPSHOT_CHUNK_BYTES)
            if not chunk:
                break
            observed_bytes += len(chunk)
            if observed_bytes > constants.MAX_SNAPSHOT_FILE_BYTES:
                raise EvaluationError(
                    f"arquivo cresceu além do limite de {constants.MAX_SNAPSHOT_FILE_BYTES} bytes: "
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
            runners.PYTHON_BEHAVIOR_RUNNER,
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
            runners.PYTHON_MUTANT_RUNNER,
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
