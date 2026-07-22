"""Executor efetivo do benchmark e fábrica de callable de execução."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

from benchmark_executor import BenchmarkExecutor, ProcessResult


ExecuteFunction = Callable[[str, str, str, Path], ProcessResult]


def _make_executor(config: dict[str, Any]) -> ExecuteFunction:
    def execute(route: str, role: str, prompt: str, cwd: Path) -> ProcessResult:
        logical_config_path = cwd / ".llm-router-quality-config.json"
        executor = BenchmarkExecutor(logical_config_path, config, cwd)
        return executor.execute_model(route, role, prompt)

    return execute
