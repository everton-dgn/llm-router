#!/usr/bin/env python3
"""Fachada compatível e CLI do benchmark determinístico de qualidade."""

from __future__ import annotations

import argparse
import hashlib
import sys
from pathlib import Path

from benchmark_executor import (
    BenchmarkExecutor,
    ConfigError,
    ProcessResult,
    load_config,
    parse_json_object,
)

from qeval.assertions import _evaluate_assertion, _failed_assertions, evaluate_assertions
from qeval.constants import (
    ASSERTION_TYPES,
    DATASET_VERSION,
    DIFFICULTIES,
    EVALUATION_MODES,
    MAX_CAPTURE_CHARS,
    MAX_SNAPSHOT_FILE_BYTES,
    MAX_SNAPSHOT_TOTAL_BYTES,
    SANDBOX_PYTHON,
    SANDBOXED_COMMAND_PREFIX,
    SNAPSHOT_CHUNK_BYTES,
    SUPPORTED_DATASET_VERSIONS,
    TEMP_PREFIX,
    UNSAFE_SNAPSHOT_PREFIX,
)
from qeval.errors import EvaluationError
from qeval.execution import _build_turn_prompt, _canary_audit, _execute_work_item
from qeval.execution_config import (
    _required_environment,
    _route_configs,
    _safe_profile_argv,
    preflight,
    prepare_execution_config,
)
from qeval.executor import ExecuteFunction, _make_executor
from qeval.filesystem import (
    _audit_files,
    _snapshot_files,
    _write_fixture,
    trash_directory,
)
from qeval.fingerprint import (
    _attach_execution_profile,
    _collect_engine_sources,
    _config_sha256,
    _engine_aggregate_sha256,
    _engine_identity,
    _engine_root,
    _engine_source_manifest,
    _execution_fingerprint,
    _rubric_sha256,
)
from qeval.manifest import (
    _build_work_items,
    _result_key,
    build_execution_manifest,
    planned_call_count,
)
from qeval.orchestration import run_benchmark
from qeval.persistence import (
    _atomic_write_json,
    _load_checkpoint,
    _reserved_ambiguous_calls,
    _validate_result_counts,
)
from qeval.reporting import (
    BLIND_IDENTITY_PATTERN,
    _redact_blind_value,
    _score_stats,
    build_anonymous_review_packets,
    build_summary,
    load_report,
    render_markdown,
    rescore_output_only_report,
    write_anonymous_review_packets,
    write_reports,
)
from qeval.runners import PYTHON_BEHAVIOR_RUNNER, PYTHON_MUTANT_RUNNER
from qeval.sandbox import (
    _behavior_probe_passed,
    _evaluate_python_behavior,
    _evaluate_python_test_mutants,
    _evaluate_sandboxed_command,
    _read_regular_text,
    _run_sandboxed_python,
    _safe_behavior_module,
    _safe_grader_file,
    _sandbox_json_response,
    _sandbox_profile,
    _validate_mutant_test_ast,
)
from qeval.textutil import (
    _json_path,
    _json_path_values,
    _regex_result,
    _reject_non_json_constant,
    _sha256_json,
    _truncate_capture,
)
from qeval.validation import (
    _assertion_type,
    _finite_number,
    _json_serializable_value,
    _non_empty_string,
    _normalized_assertion,
    _normalized_human_evaluation,
    _normalized_human_rubric,
    _normalized_sandboxed_command_argv,
    _positive_int,
    _positive_or_zero_int,
    _safe_python_symbol_path,
    _safe_relative_path,
    load_dataset,
    load_selection,
    parse_routes,
    validate_dataset,
    validate_routes,
    validate_selection,
)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Executa um benchmark determinístico de qualidade das rotas"
    )
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--cases", required=True, type=Path)
    parser.add_argument("--routes", help="nomes de rotas separados por vírgula; padrão: todas")
    parser.add_argument(
        "--selection",
        type=Path,
        help="JSON opcional que seleciona as rotas executadas em cada caso",
    )
    parser.add_argument("--repetitions", type=int, default=3)
    parser.add_argument("--parallel", type=int, default=1)
    parser.add_argument("--max-calls", type=int, default=72)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--output", required=True, type=Path, help="relatório JSON")
    parser.add_argument("--validate-only", action="store_true")
    parser.add_argument(
        "--manifest-output", type=Path, help="grava o manifesto do dry-run em JSON"
    )
    parser.add_argument(
        "--checkpoint", type=Path, help="checkpoint atômico; padrão derivado de --output"
    )
    parser.add_argument("--resume", action="store_true", help="retoma um checkpoint existente")
    parser.add_argument(
        "--retry-ambiguous",
        action="store_true",
        help="repete slots ambiguous com aumento explícito de --max-calls",
    )
    parser.add_argument(
        "--replay-report",
        type=Path,
        help="reavalia saídas de um relatório existente sem chamar modelos",
    )
    parser.add_argument(
        "--human-review-dir",
        type=Path,
        help="diretório que receberá somente o pacote cego",
    )
    parser.add_argument(
        "--human-mapping-dir",
        type=Path,
        help="diretório privado separado que receberá o mapping",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        repetitions = _positive_int(args.repetitions, "--repetitions")
        parallel = _positive_int(args.parallel, "--parallel")
        max_calls = _positive_int(args.max_calls, "--max-calls")
        config_path = args.config.expanduser().resolve()
        cases_path = args.cases.expanduser().resolve()
        output_path = args.output.expanduser().resolve()
        if output_path.suffix.lower() != ".json":
            raise EvaluationError("--output precisa terminar em .json")
        config = load_config(config_path)
        dataset = load_dataset(cases_path)
        if args.replay_report is not None:
            if args.validate_only:
                raise EvaluationError("--replay-report não pode ser combinado com --validate-only")
            source_path = args.replay_report.expanduser().resolve()
            if source_path == output_path:
                raise EvaluationError("--output precisa ser diferente de --replay-report")
            report = rescore_output_only_report(load_report(source_path), dataset, source_path)
            report["audit"]["rescore_dataset_source"] = str(cases_path)
            report["audit"]["rescore_dataset_source_sha256"] = hashlib.sha256(
                cases_path.read_bytes()
            ).hexdigest()
            json_path, markdown_path = write_reports(output_path, report)
            print(f"relatórios reavaliados: {json_path} e {markdown_path}")
            return 0
        requested_routes = parse_routes(args.routes)
        available_routes = validate_routes(config, requested_routes, set())
        selection = (
            load_selection(
                args.selection.expanduser().resolve(), dataset, available_routes
            )
            if args.selection is not None
            else None
        )
        selected_cases = [
            case
            for case in dataset["cases"]
            if selection is None or case["id"] in selection
        ]
        roles = {case["role"] for case in selected_cases}
        if selection is None:
            routes = validate_routes(config, requested_routes, roles)
        else:
            routes = available_routes
            routes = [
                route
                for route in routes
                if any(route in selected_routes for selected_routes in selection.values())
            ]
            for route in routes:
                required_roles = {
                    case["role"]
                    for case in selected_cases
                    if route in selection.get(case["id"], [])
                }
                validate_routes(config, [route], required_roles)
        manifest = build_execution_manifest(
            config_path,
            config,
            dataset,
            routes,
            repetitions,
            args.seed,
            selection,
        )
        call_count = manifest["physical_call_count"]
        if call_count > max_calls and not args.validate_only:
            raise EvaluationError(
                f"benchmark exigiria {call_count} chamadas, acima de --max-calls={max_calls}"
            )
        if args.manifest_output is not None:
            manifest_path = args.manifest_output.expanduser().resolve()
            if manifest_path.suffix.lower() != ".json":
                raise EvaluationError("--manifest-output precisa terminar em .json")
            _atomic_write_json(manifest_path, manifest)
        if args.validate_only:
            selected_cases = [
                case
                for case in dataset["cases"]
                if selection is None or case["id"] in selection
            ]
            selected_roles = {case["role"] for case in selected_cases}
            route_roles = {
                route: {
                    case["role"]
                    for case in selected_cases
                    if selection is None or route in selection.get(case["id"], [])
                }
                for route in routes
            }
            execution_config, _ = prepare_execution_config(
                config, routes, selected_roles, route_roles
            )
            preflight(
                execution_config,
                routes,
                selected_roles,
                {
                    assertion["type"]
                    for case in selected_cases
                    for assertion in case["assertions"]
                },
                route_roles,
            )
            print(
                f"válido: {len(selected_cases)} casos, {len(routes)} rotas, "
                f"{manifest['slot_count']} slots e {call_count} chamadas físicas planejadas"
            )
            return 0
        checkpoint_path = (
            args.checkpoint.expanduser().resolve()
            if args.checkpoint is not None
            else output_path.with_name(f"{output_path.stem}.checkpoint.json")
        )
        report = run_benchmark(
            config_path,
            config,
            dataset,
            routes,
            repetitions,
            parallel,
            max_calls,
            args.seed,
            progress=True,
            checkpoint_path=checkpoint_path,
            resume=args.resume,
            retry_ambiguous=args.retry_ambiguous,
            selection=selection,
        )
        report["cases"] = str(cases_path)
        report["dataset_source_sha256"] = hashlib.sha256(cases_path.read_bytes()).hexdigest()
        json_path, markdown_path = write_reports(output_path, report)
        human_paths = write_anonymous_review_packets(
            output_path,
            report,
            dataset,
            args.seed,
            args.human_review_dir,
            args.human_mapping_dir,
        )
        print(f"relatórios: {json_path} e {markdown_path}")
        if human_paths is not None:
            print(f"avaliação humana cega: {human_paths[0]}")
        return 0
    except (ConfigError, EvaluationError, OSError) as error:
        print(f"erro: {error}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("benchmark interrompido", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
