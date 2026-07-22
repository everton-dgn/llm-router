"""Constantes escalares, tipos de assertion, limites, padrões e nomes."""

from __future__ import annotations

from pathlib import Path


DATASET_VERSION = 2
SUPPORTED_DATASET_VERSIONS = {1, 2}
DIFFICULTIES = {"simple", "intermediate", "hard"}
EVALUATION_MODES = {"objective", "human", "hybrid"}
SANDBOX_PYTHON = Path(
    "/Applications/Xcode.app/Contents/Developer/usr/bin/python3"
)
MAX_CAPTURE_CHARS = 20_000
MAX_SNAPSHOT_FILE_BYTES = 16 * 1024 * 1024
MAX_SNAPSHOT_TOTAL_BYTES = 64 * 1024 * 1024
SNAPSHOT_CHUNK_BYTES = 1024 * 1024
UNSAFE_SNAPSHOT_PREFIX = "!unsafe:"
TEMP_PREFIX = "llm-router-quality-"
SANDBOXED_COMMAND_PREFIX = [
    "uv",
    "run",
    "--no-project",
    "--no-python-downloads",
    "python",
]
ASSERTION_TYPES = {
    "file_regex_count",
    "output_character_count_range",
    "output_all_patterns",
    "output_each_regex",
    "output_hashtag_count_max",
    "output_json_all_match",
    "output_json_all_lengths",
    "output_json_all_non_empty",
    "output_json_all_non_empty_values",
    "output_json_all_patterns",
    "output_json_ends_with_path",
    "output_json_equals",
    "output_json_length",
    "output_json_length_range",
    "output_json_last_item_regex",
    "output_json_number_range",
    "output_json_non_empty",
    "output_json_one_of",
    "output_json_sum_max",
    "output_json_values_in",
    "output_strict_json_object",
    "output_regex",
    "output_regex_count",
    "output_not_regex",
    "output_unique_values",
    "output_word_count_range",
    "python_behavior",
    "python_test_mutants",
    "file_regex",
    "file_not_regex",
    "command",
}
