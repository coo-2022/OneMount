"""Run pinned, unmodified JuiceFS Windows cases on an isolated test drive.

Only setUp's hard-coded Z:\\test_fs location is replaced. Assertions and the
upstream symlink skip remain unchanged. Never point this at a user directory.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import unittest

source, fixture, output, nonce = sys.argv[1:]
assert hashlib.sha256(Path(source).read_bytes()).hexdigest() == (
    "cdd6dd8a35f8286af4e943994c98671aaa41a7a41c40b2519d0726f78d5af9e9"
), "Upstream test source changed"
fixture = Path(fixture).resolve()
assert fixture.parent == Path(fixture.anchor), "Test fixture must be directly under the test drive"
assert fixture.name == "onemount-upstream-" + nonce
assert (fixture / "owner.txt").read_text() == nonce
spec = importlib.util.spec_from_file_location("juicefs_upstream_windows", source)
upstream = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upstream)


def set_up(self):
    self.test_dir = str(fixture / "test_fs")
    self.ensure_clean_dir(self.test_dir)


upstream.WindowsFSTest.setUp = set_up
cases = []


class Result(unittest.TextTestResult):
    def addSuccess(self, test):
        super().addSuccess(test)
        cases.append({"name": test._testMethodName, "status": "passed"})

    def addSkip(self, test, reason):
        super().addSkip(test, reason)
        cases.append({"name": test._testMethodName, "status": "skipped", "reason": reason})

    def addFailure(self, test, err):
        super().addFailure(test, err)
        cases.append({"name": test._testMethodName, "status": "failed"})

    def addError(self, test, err):
        super().addError(test, err)
        cases.append({"name": test._testMethodName, "status": "error"})


result = unittest.TextTestRunner(verbosity=2, resultclass=Result).run(
    unittest.defaultTestLoader.loadTestsFromTestCase(upstream.WindowsFSTest)
)
Path(output).write_text(json.dumps({"run": result.testsRun, "cases": cases,
    "passed": result.wasSuccessful()}, indent=2), encoding="utf-8")
sys.exit(0 if result.wasSuccessful() else 1)
