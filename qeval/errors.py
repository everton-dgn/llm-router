"""Exceções compartilhadas pelo motor de benchmark."""

from __future__ import annotations


class EvaluationError(RuntimeError):
    """Raised when the benchmark input or execution is invalid."""
