import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("sensitive_files", Path(__file__).with_name("check-sensitive-files.py"))
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)


class SensitiveFileTests(unittest.TestCase):
    def test_binary_containers_and_private_key_names_are_blocked(self):
        paths = ["keys/Developer ID.p12", "AuthKey_123.P8", "release.pfx", "keys/updater.key",
                 "cert.pem", "backup.keychain-db", "keys/id_ed25519", "updater.password"]
        self.assertEqual(check.sensitive_paths(paths), paths)

    def test_public_updater_key_and_documentation_are_allowed(self):
        self.assertEqual(check.sensitive_paths(["updater.key.pub", "SECURITY.md", "src/key.ts"]), [])
