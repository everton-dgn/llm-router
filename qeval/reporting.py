"""Resumos, replay, anonimização, markdown e escrita de relatórios."""

from __future__ import annotations

import copy
import hashlib
import json
import os
import random
import re
import statistics
import tempfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from qeval import fingerprint
from qeval.assertions import evaluate_assertions
from qeval.errors import EvaluationError
from qeval.persistence import _atomic_write_json
from qeval.textutil import _sha256_json


def _score_stats(items: list[dict[str, Any]]) -> dict[str, float]:
    scores = [float(item["score"]) for item in items]
    passed = sum(item["status"] == "passed" for item in items)
    return {
        "mean": round(statistics.fmean(scores), 6) if scores else 0.0,
        "median": round(statistics.median(scores), 6) if scores else 0.0,
        "worst": round(min(scores), 6) if scores else 0.0,
        "pass_rate": round(100.0 * passed / len(items), 6) if items else 0.0,
    }


def build_summary(results: list[dict[str, Any]]) -> dict[str, Any]:
    by_route: dict[str, list[dict[str, Any]]] = defaultdict(list)
    by_category: dict[str, list[dict[str, Any]]] = defaultdict(list)
    by_difficulty: dict[str, list[dict[str, Any]]] = defaultdict(list)
    by_route_category: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    by_route_category_difficulty: dict[
        tuple[str, str, str], list[dict[str, Any]]
    ] = defaultdict(list)
    for result in results:
        difficulty = result.get("difficulty", "legacy")
        by_route[result["route"]].append(result)
        by_category[result["category"]].append(result)
        by_difficulty[difficulty].append(result)
        by_route_category[(result["route"], result["category"])].append(result)
        by_route_category_difficulty[
            (result["route"], result["category"], difficulty)
        ].append(result)
    crossed: dict[str, dict[str, dict[str, float]]] = defaultdict(dict)
    for (route, category), items in sorted(by_route_category.items()):
        crossed[route][category] = _score_stats(items)
    crossed_difficulty: dict[
        str, dict[str, dict[str, dict[str, float]]]
    ] = defaultdict(lambda: defaultdict(dict))
    for (route, category, difficulty), items in sorted(
        by_route_category_difficulty.items()
    ):
        crossed_difficulty[route][category][difficulty] = _score_stats(items)
    return {
        "overall": _score_stats(results),
        "by_route": {name: _score_stats(items) for name, items in sorted(by_route.items())},
        "by_category": {
            name: _score_stats(items) for name, items in sorted(by_category.items())
        },
        "by_difficulty": {
            name: _score_stats(items) for name, items in sorted(by_difficulty.items())
        },
        "by_route_category": dict(crossed),
        "by_route_category_difficulty": {
            route: dict(categories) for route, categories in crossed_difficulty.items()
        },
        "status_counts": dict(sorted(Counter(result["status"] for result in results).items())),
    }


def load_report(path: Path) -> dict[str, Any]:
    try:
        with path.open(encoding="utf-8") as stream:
            report = json.load(stream)
    except OSError as error:
        raise EvaluationError(f"não foi possível ler relatório: {error}") from error
    except json.JSONDecodeError as error:
        raise EvaluationError(f"relatório JSON inválido: {error}") from error
    if not isinstance(report, dict) or not isinstance(report.get("results"), list):
        raise EvaluationError("relatório precisa conter results como lista")
    return report


def rescore_output_only_report(
    report: dict[str, Any], dataset: dict[str, Any], source_path: Path
) -> dict[str, Any]:
    rescored_report = copy.deepcopy(report)
    cases = {case["id"]: case for case in dataset["cases"]}
    rescored_count = 0
    retained_count = 0
    for result in rescored_report["results"]:
        case_id = result.get("case_id")
        case = cases.get(case_id)
        if case is None:
            raise EvaluationError(f"relatório contém caso ausente no dataset: {case_id}")
        output_only = (
            case["evaluation_mode"] in {"objective", "hybrid"}
            and case["role"] == "judge"
            and all(
                assertion["type"].startswith("output_")
                for assertion in case["assertions"]
            )
        )
        if not output_only or result.get("process_status") != "success":
            retained_count += 1
            continue

        original_evaluation = {
            "score": result.get("score"),
            "status": result.get("status"),
            "critical_failure": result.get("critical_failure"),
            "assertions": result.get("assertions", []),
        }
        score, assertion_results = evaluate_assertions(
            case["assertions"],
            result.get("output", ""),
            Path(tempfile.gettempdir()),
            [item.get("output", "") for item in result.get("turn_results", [])] or None,
        )
        retained_audits = [
            assertion
            for assertion in original_evaluation["assertions"]
            if assertion.get("type") in {"allowed_files", "canary_leak"}
        ]
        assertion_results.extend(retained_audits)
        critical_failed = any(
            assertion.get("critical", False) and not assertion.get("passed", False)
            for assertion in assertion_results
        )
        if critical_failed:
            score = 0.0
        result.update(
            {
                "original_evaluation": original_evaluation,
                "score": round(score, 6),
                "status": (
                    "passed"
                    if not critical_failed
                    and all(assertion.get("passed", False) for assertion in assertion_results)
                    else "failed"
                ),
                "critical_failure": critical_failed,
                "assertions": assertion_results,
            }
        )
        rescored_count += 1

    source_content = source_path.read_bytes()
    rescored_report["summary"] = build_summary(rescored_report["results"])
    rescored_report["audit"] = {
        "source_report": str(source_path),
        "source_report_sha256": hashlib.sha256(source_content).hexdigest(),
        "source_generated_at": report.get("generated_at"),
        "rescored_at": datetime.now(timezone.utc).isoformat(),
        "rescore_dataset_sha256": _sha256_json(dataset),
        "rescore_rubric_sha256": fingerprint._rubric_sha256(dataset),
        "rescore_engine": fingerprint._engine_identity(),
        "rescored_output_only_results": rescored_count,
        "retained_workspace_results": retained_count,
        "original_summary": report.get("summary"),
        "method": (
            "reaplica o dataset atual somente a assertions de saída; "
            "resultados que dependem do workspace mantêm a avaliação original"
        ),
    }
    return rescored_report


BLIND_IDENTITY_PATTERN = re.compile(
    r"(?i)(?<![A-Za-z0-9])(?:minimax|m3|glm|5\.2|claude|opus|codex|gpt|5\.6|sol|anthropic|z\.ai|openai)(?![A-Za-z0-9])"
)


def _redact_blind_value(
    value: Any, canaries: list[str] | tuple[str, ...]
) -> tuple[Any, int]:
    if isinstance(value, str):
        redacted, count = BLIND_IDENTITY_PATTERN.subn("[IDENTITY_REDACTED]", value)
        for canary in dict.fromkeys(item for item in canaries if item):
            redacted, canary_count = re.subn(
                re.escape(canary), "[CANARY_REDACTED]", redacted, flags=re.IGNORECASE
            )
            count += canary_count
        return redacted, count
    if isinstance(value, list):
        result: list[Any] = []
        total = 0
        for item in value:
            redacted, count = _redact_blind_value(item, canaries)
            result.append(redacted)
            total += count
        return result, total
    if isinstance(value, dict):
        result_dict: dict[str, Any] = {}
        total = 0
        for key, item in value.items():
            redacted, count = _redact_blind_value(item, canaries)
            result_dict[key] = redacted
            total += count
        return result_dict, total
    return value, 0


def build_anonymous_review_packets(
    report: dict[str, Any], dataset: dict[str, Any], seed: int = 42
) -> tuple[dict[str, Any], dict[str, Any]]:
    cases = {case["id"]: case for case in dataset["cases"]}
    candidates: list[
        tuple[dict[str, Any], dict[str, Any], tuple[str, ...]]
    ] = []
    for result in report["results"]:
        case = cases[result["case_id"]]
        if case["human_rubric"] is None:
            continue
        turn_results = result.get("turn_results") or [
            {"turn": 1, "output": result.get("output", "")}
        ]
        blind_item = {
            "case_id": case["id"],
            "category": case["category"],
            "difficulty": case["difficulty"],
            "evaluation_mode": case["evaluation_mode"],
            "repetition": result["repetition"],
            "user_turns": case["turns"],
            "assistant_turns": [item.get("output", "") for item in turn_results],
            "human_rubric": case["human_rubric"],
        }
        mapping_item = {
            "route": result["route"],
            "case_id": case["id"],
            "repetition": result["repetition"],
            "output_sha256": result["output_sha256"],
        }
        canaries = tuple(
            canary
            for canary in (dataset.get("canary"), case.get("canary"))
            if canary
        )
        candidates.append((blind_item, mapping_item, canaries))
    human_evaluation = dataset.get("human_evaluation")
    if human_evaluation is None or human_evaluation.get("randomize_output_order", True):
        random.Random(seed).shuffle(candidates)

    blind_items: list[dict[str, Any]] = []
    mapping_items: list[dict[str, Any]] = []
    redaction_count = 0
    for index, (blind_item, mapping_item, canaries) in enumerate(candidates, start=1):
        candidate_id = f"candidate-{index:04d}"
        redacted, count = _redact_blind_value(blind_item, canaries)
        redaction_count += count
        blind_items.append({"candidate_id": candidate_id, **redacted})
        mapping_items.append({"candidate_id": candidate_id, **mapping_item})

    common = {
        "version": 1,
        "generated_at": report["generated_at"],
        "plan_sha256": report["plan_sha256"],
        "rubric_sha256": report["rubric_sha256"],
    }
    blind_packet = {
        **common,
        "instructions": (
            "Avalie cada candidato somente pelos turnos e pela rubrica. "
            "Preencha uma nota por critério dentro da escala declarada."
        ),
        "identity_redaction_count": redaction_count,
        "human_evaluation": human_evaluation,
        "candidates": blind_items,
    }
    mapping_packet = {**common, "candidates": mapping_items}
    return blind_packet, mapping_packet


def render_markdown(report: dict[str, Any]) -> str:
    summary = report["summary"]
    lines = [
        "# Benchmark de qualidade",
        "",
        f"Chamadas físicas planejadas: {report['calls']}",
    ]
    if report.get("physical_call_accounting") == "upper_bound":
        lines.extend(
            [
                "Limite superior de chamadas físicas após retries ambiguous: "
                f"{report['physical_calls_upper_bound']}",
                "Chamadas associadas a resultados concluídos: "
                f"{report['recorded_result_calls']}",
            ]
        )
    else:
        lines.append(
            "Chamadas físicas executadas: "
            f"{report.get('executed_calls', report.get('recorded_result_calls', report['calls']))}"
        )
    lines.extend(
        [
            f"Repetições: {report['repetitions']}",
            f"Escopo: {report['scope']}",
            f"Score geral: {summary['overall']['mean']:.2f}%",
            "",
            "## Resultado por rota",
            "",
            "| Rota | Média | Mediana | Pior | Aprovação |",
            "| --- | ---: | ---: | ---: | ---: |",
        ]
    )
    for route, stats in summary["by_route"].items():
        lines.append(
            f"| {route} | {stats['mean']:.2f}% | {stats['median']:.2f}% | "
            f"{stats['worst']:.2f}% | {stats['pass_rate']:.2f}% |"
        )
    lines.extend(
        [
            "",
            "## Resultado por categoria",
            "",
            "| Categoria | Média | Mediana | Pior | Aprovação |",
            "| --- | ---: | ---: | ---: | ---: |",
        ]
    )
    for category, stats in summary["by_category"].items():
        safe_category = category.replace("|", "\\|")
        lines.append(
            f"| {safe_category} | {stats['mean']:.2f}% | {stats['median']:.2f}% | "
            f"{stats['worst']:.2f}% | {stats['pass_rate']:.2f}% |"
        )
    lines.extend(
        [
            "",
            "## Resultado por dificuldade",
            "",
            "| Dificuldade | Média | Mediana | Pior | Aprovação |",
            "| --- | ---: | ---: | ---: | ---: |",
        ]
    )
    for difficulty, stats in summary.get("by_difficulty", {}).items():
        lines.append(
            f"| {difficulty} | {stats['mean']:.2f}% | {stats['median']:.2f}% | "
            f"{stats['worst']:.2f}% | {stats['pass_rate']:.2f}% |"
        )
    lines.extend(
        [
            "",
            "## Resultado por rota e categoria",
            "",
            "| Rota | Categoria | Média | Mediana | Pior | Aprovação |",
            "| --- | --- | ---: | ---: | ---: | ---: |",
        ]
    )
    for route, categories in summary["by_route_category"].items():
        for category, stats in categories.items():
            safe_category = category.replace("|", "\\|")
            lines.append(
                f"| {route} | {safe_category} | {stats['mean']:.2f}% | "
                f"{stats['median']:.2f}% | {stats['worst']:.2f}% | "
                f"{stats['pass_rate']:.2f}% |"
            )
    lines.extend(
        [
            "",
            "## Resultado por rota, categoria e dificuldade",
            "",
            "| Rota | Categoria | Dificuldade | Média | Mediana | Pior | Aprovação |",
            "| --- | --- | --- | ---: | ---: | ---: | ---: |",
        ]
    )
    for route, categories in summary.get("by_route_category_difficulty", {}).items():
        for category, difficulties in categories.items():
            for difficulty, stats in difficulties.items():
                safe_category = category.replace("|", "\\|")
                lines.append(
                    f"| {route} | {safe_category} | {difficulty} | {stats['mean']:.2f}% | "
                    f"{stats['median']:.2f}% | {stats['worst']:.2f}% | "
                    f"{stats['pass_rate']:.2f}% |"
                )
    lines.extend(
        [
            "",
            "## Execuções",
            "",
            "| Rota | Papel | Caso | Repetição | Status | Score | SHA-256 |",
            "| --- | --- | --- | ---: | --- | ---: | --- |",
        ]
    )
    for result in report["results"]:
        lines.append(
            f"| {result['route']} | {result['role']} | {result['case_id']} | "
            f"{result['repetition']} | "
            f"{result['status']} | {result['score']:.2f}% | `{result['output_sha256']}` |"
        )
    return "\n".join(lines) + "\n"


def write_reports(output_path: Path, report: dict[str, Any]) -> tuple[Path, Path]:
    if output_path.suffix.lower() != ".json":
        raise EvaluationError("--output precisa terminar em .json")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    markdown_path = output_path.with_suffix(".md")
    output_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    markdown_path.write_text(render_markdown(report), encoding="utf-8")
    return output_path, markdown_path


def write_anonymous_review_packets(
    output_path: Path,
    report: dict[str, Any],
    dataset: dict[str, Any],
    seed: int,
    blind_dir: Path | None = None,
    mapping_dir: Path | None = None,
) -> tuple[Path, Path] | None:
    if not any(
        case["human_rubric"] is not None for case in dataset["cases"]
    ):
        return None
    blind_packet, mapping_packet = build_anonymous_review_packets(report, dataset, seed)
    resolved_blind_dir = (
        blind_dir or output_path.with_name(f"{output_path.stem}-human-review")
    ).expanduser().resolve()
    resolved_mapping_dir = (
        mapping_dir or output_path.with_name(f"{output_path.stem}-human-mapping")
    ).expanduser().resolve()
    if (
        resolved_blind_dir == resolved_mapping_dir
        or resolved_blind_dir.is_relative_to(resolved_mapping_dir)
        or resolved_mapping_dir.is_relative_to(resolved_blind_dir)
    ):
        raise EvaluationError(
            "os diretórios de avaliação cega e mapping precisam ser separados"
        )
    resolved_blind_dir.mkdir(parents=True, exist_ok=True)
    resolved_mapping_dir.mkdir(parents=True, mode=0o700, exist_ok=True)
    os.chmod(resolved_mapping_dir, 0o700)
    blind_path = resolved_blind_dir / "review.json"
    mapping_path = resolved_mapping_dir / "mapping.json"
    _atomic_write_json(blind_path, blind_packet)
    _atomic_write_json(mapping_path, mapping_packet)
    os.chmod(mapping_path, 0o600)
    return blind_path, mapping_path
