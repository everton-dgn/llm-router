"""Fontes Python executadas no sandbox para graders de behavior e mutantes."""

from __future__ import annotations


PYTHON_BEHAVIOR_RUNNER = r"""
import contextlib
import importlib.util
import io
import json
import os
import sys

request = json.loads(sys.stdin.read())
sys.stdin = io.StringIO("")
sys.path.insert(0, os.path.realpath(os.getcwd()))
capture = io.StringIO()
try:
    with contextlib.redirect_stdout(capture), contextlib.redirect_stderr(capture):
        module_path = os.path.join(*request["module"].split(".")) + ".py"
        spec = importlib.util.spec_from_file_location(request["module"], module_path)
        if spec is None or spec.loader is None:
            raise ImportError("module spec unavailable")
        module = importlib.util.module_from_spec(spec)
        sys.modules[request["module"]] = module
        spec.loader.exec_module(module)
        target = module
        for segment in request["call"].split("."):
            target = getattr(target, segment)
        if not callable(target):
            raise TypeError("target is not callable")
        value = target(*request["args"], **request["kwargs"])
    response = {"status": "returned", "type": type(value).__name__}
    try:
        json.dumps(value, ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError):
        response["value"] = None
        response["value_serializable"] = False
    else:
        response["value"] = value
except BaseException as error:
    response = {"status": "exception", "exception": type(error).__name__}
sys.stdout.write(json.dumps(response, ensure_ascii=False, allow_nan=False) + "\n")
"""

PYTHON_MUTANT_RUNNER = r"""
import builtins
import contextlib
import io
import json
import sys
import types
import unittest

def consume_sources():
    raw = sys.stdin.read()
    sys.stdin = io.StringIO("")
    payload = json.loads(raw)
    raw = None
    module_name = payload.pop("module")
    module_source = payload.pop("module_source")
    test_source = payload.pop("test_source")
    module_code = compile(module_source, "<candidate-module>", "exec")
    test_code = compile(test_source, "<candidate-test>", "exec")
    module_source = None
    test_source = None
    payload.clear()
    return module_name, module_code, test_code

module_name, module_code, test_code = consume_sources()
del consume_sources
real_import = builtins.__import__
allowed_import_roots = {
    "collections",
    "decimal",
    "fractions",
    "functools",
    "itertools",
    "math",
    "queue",
    "threading",
    "time",
    "types",
    "unittest",
}

def guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
    if level != 0:
        raise ImportError("relative imports are disabled")
    root = name.split(".", 1)[0]
    if name == module_name:
        return sys.modules[module_name]
    if root not in allowed_import_roots:
        raise ImportError("import is not allowed")
    return real_import(name, globals, locals, fromlist, level)

safe_builtins = dict(vars(builtins))
for blocked_name in (
    "breakpoint",
    "compile",
    "delattr",
    "dir",
    "eval",
    "exec",
    "getattr",
    "globals",
    "help",
    "input",
    "locals",
    "open",
    "setattr",
    "vars",
):
    safe_builtins.pop(blocked_name, None)
safe_builtins["__import__"] = guarded_import

capture = io.StringIO()
try:
    with contextlib.redirect_stdout(capture), contextlib.redirect_stderr(capture):
        candidate_module = types.ModuleType(module_name)
        candidate_module.__dict__.update(
            {
                "__name__": module_name,
                "__package__": "",
                "__builtins__": safe_builtins,
            }
        )
        sys.modules[module_name] = candidate_module
        exec(module_code, candidate_module.__dict__)
        candidate_tests = types.ModuleType("quality_candidate_tests")
        candidate_tests.__dict__.update(
            {
                "__name__": "quality_candidate_tests",
                "__package__": "",
                "__builtins__": safe_builtins,
            }
        )
        exec(test_code, candidate_tests.__dict__)
        suite = unittest.defaultTestLoader.loadTestsFromModule(candidate_tests)
        result = unittest.TextTestRunner(stream=capture, verbosity=0).run(suite)
    response = {"status": "completed", "successful": result.wasSuccessful()}
except BaseException as error:
    response = {"status": "harness_error", "exception": type(error).__name__}
sys.stdout.write(json.dumps(response, sort_keys=True) + "\n")
"""
