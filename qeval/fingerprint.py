"""Hashes de engine, fingerprint de execução e perfil de manifesto."""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path
from typing import Any

from benchmark_executor import BenchmarkExecutor

from qeval.textutil import _sha256_json


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


def _engine_root() -> Path:
    """Diretório do repositório que abriga ``quality_eval.py`` e o pacote ``qeval``."""
    return Path(__file__).resolve().parent.parent


def _collect_engine_sources() -> list[tuple[str, bytes]]:
    """Coleta ``quality_eval.py`` e todos os ``qeval/*.py`` ordenados por caminho relativo.

    Caches e arquivos não ``.py`` são excluídos; somente arquivos ``.py`` reais
    do pacote (não recursivo além do nível imediato de ``qeval/``) participam.
    """
    engine_root = _engine_root()
    qeval_dir = Path(__file__).resolve().parent
    sources: list[tuple[str, bytes]] = []
    quality_eval_path = engine_root / "quality_eval.py"
    sources.append(("quality_eval.py", quality_eval_path.read_bytes()))
    for py_file in sorted(qeval_dir.glob("*.py")):
        relative = py_file.relative_to(engine_root).as_posix()
        sources.append((relative, py_file.read_bytes()))
    sources.sort(key=lambda item: item[0])
    return sources


def _engine_source_manifest(
    sources: list[tuple[str, bytes]] | None = None,
) -> list[dict[str, str]]:
    """Manifesto determinístico ``[{path, sha256}, ...]`` das fontes do engine."""
    if sources is None:
        sources = _collect_engine_sources()
    manifest = [
        {"path": relative, "sha256": hashlib.sha256(content).hexdigest()}
        for relative, content in sorted(sources, key=lambda item: item[0])
    ]
    manifest.sort(key=lambda item: item["path"])
    return manifest


def _engine_aggregate_sha256(sources: list[tuple[str, bytes]] | None = None) -> str:
    """Hash agregado determinístico cobrindo nome relativo + SHA-256 de cada fonte."""
    manifest = _engine_source_manifest(sources)
    encoded = json.dumps(
        manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _engine_identity() -> dict[str, str]:
    benchmark_executor_path = Path(
        sys.modules[BenchmarkExecutor.__module__].__file__
    ).resolve()
    return {
        "quality_eval_sha256": _engine_aggregate_sha256(),
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
