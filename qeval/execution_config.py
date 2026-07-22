"""Preparação de config efetiva, rotas, ambiente e preflight."""

from __future__ import annotations

import copy
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

from qeval import constants
from qeval.errors import EvaluationError


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
        if not constants.SANDBOX_PYTHON.is_file():
            raise EvaluationError(
                f"{constants.SANDBOX_PYTHON} é obrigatório para assertions Python seguras"
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
