import copy
from datetime import date
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("audit_dependencies", Path(__file__).with_name("audit-dependencies.py"))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class AdvisoryPolicyTests(unittest.TestCase):
    def setUp(self):
        self.finding = {"package": {"name": "glib", "version": "0.18.5",
                        "source": "registry+https://github.com/rust-lang/crates.io-index"},
                        "advisory": {"id": "RUSTSEC-2024-0429"}}
        self.report = {"settings": {"ignore": [], "informational_warnings": ["unmaintained", "unsound", "notice"]},
                       "vulnerabilities": {"count": 0, "list": []}, "warnings": {"unsound": [self.finding]}}
        self.policy = {"schema": 1, "exceptions": [{"id": "RUSTSEC-2024-0429", "package": "glib", "version": "0.18.5",
                       "kind": "unsound", "scope": "non-macos", "reason": "GTK dependency; not shipped on macOS",
                       "review_by": "2027-01-02"}]}

    def assess(self, macos=()):
        return audit.assess(self.report, self.policy, set(macos), date(2026, 10, 4))

    def test_reviewed_nonshipping_finding_is_accepted(self):
        self.assertEqual(len(self.assess()), 1)

    def test_scope_change_to_shipped_target_fails(self):
        with self.assertRaisesRegex(ValueError, "now affects a shipped target"):
            self.assess([("glib", "0.18.5")])

    def test_new_advisory_or_version_is_not_silently_ignored(self):
        for key, value in [("version", "0.18.6"), ("name", "different")]:
            with self.subTest(field=key):
                original = self.finding["package"][key]
                self.finding["package"][key] = value
                with self.assertRaisesRegex(ValueError, "Unreviewed advisory"):
                    self.assess()
                self.finding["package"][key] = original
        new = copy.deepcopy(self.finding)
        new["advisory"]["id"] = "RUSTSEC-2099-0001"
        self.report["vulnerabilities"] = {"count": 1, "list": [new]}
        with self.assertRaisesRegex(ValueError, "Unreviewed advisory"):
            self.assess()

    def test_expired_or_stale_exception_fails(self):
        with self.assertRaisesRegex(ValueError, "Expired"):
            audit.assess(self.report, self.policy, set(), date(2027, 1, 2))
        self.report["warnings"] = {}
        with self.assertRaisesRegex(ValueError, "stale"):
            self.assess()

    def test_prefiltered_scan_is_rejected(self):
        self.report["settings"]["ignore"] = ["RUSTSEC-2024-0429"]
        with self.assertRaisesRegex(ValueError, "must not filter"):
            self.assess()

    def test_maintenance_exception_cannot_hide_unsoundness(self):
        self.policy["exceptions"][0]["scope"] = "upstream-maintenance"
        with self.assertRaisesRegex(ValueError, "Invalid exception scope"):
            self.assess()
