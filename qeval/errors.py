"""Exceptions shared by the benchmark engine."""

from __future__ import annotations


class EvaluationError(RuntimeError):
    """Raised when the benchmark input or execution is invalid."""
