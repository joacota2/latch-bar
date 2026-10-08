"""Regression tests for release attribution failures, without network or package execution."""
import base64
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("third_party", Path(__file__).with_name("third-party.py"))
licenses = importlib.util.module_from_spec(spec)
spec.loader.exec_module(licenses)


class AttributionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "repo"
        self.root.mkdir()
        for name in licenses.INPUTS:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("fixture\n")
        self.write_json("package.json", {"name": "app", "version": "1.0.0"})
        self.write_json("package-lock.json", {"version": "1.0.0", "packages": {
            "": {"name": "app", "version": "1.0.0"},
            "node_modules/example": {"version": "2.0.0"}}})
        (self.root / "src-tauri/Cargo.toml").write_text('[package]\nname = "app"\nversion = "1.0.0"\n')
        (self.root / "src-tauri/Cargo.lock").write_text('[[package]]\nname = "app"\nversion = "1.0.0"\n')
        self.write_json("third-party/supplements.json", {"assets": []})
        self.write_json("third-party/provenance.json", {"first_party_assets_sha256": {}})
        self.source = "third-party/sources/example-2.0.0.crate"
        (self.root / self.source).parent.mkdir()
        (self.root / self.source).write_bytes(b"MPL fixture source")
        for name in ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.txt"]:
            (self.root / name).write_text("fixture " + name)
        self.manifest = {
            "schema": 1, "targets": licenses.TARGETS,
            "input_sha256": licenses.input_hashes(self.root),
            "output_sha256": {p: licenses.sha256((self.root / p).read_bytes())
                              for p in ["THIRD_PARTY_NOTICES.txt", self.source]},
            "packages": [{"id": "cargo:example@2.0.0", "license": "MPL-2.0",
                          "notices": [{"text_sha256": "fixture"}], "bundled_source": self.source,
                          "integrity": "sha256-" + base64.b64encode(
                              bytes.fromhex(licenses.sha256(b"MPL fixture source"))).decode()}]}
        self.save_manifest()

    def write_json(self, path, data):
        (self.root / path).write_text(json.dumps(data))

    def save_manifest(self):
        self.write_json("third-party/manifest.json", self.manifest)

    def check(self):
        with contextlib.redirect_stdout(io.StringIO()):
            licenses.check(self.root)

    def test_changed_dependency_invalidates_notices(self):
        self.check()
        path = self.root / "package-lock.json"
        path.write_text(path.read_text().replace("2.0.0", "2.0.1"))
        with self.assertRaisesRegex(ValueError, "Attribution inputs changed"):
            self.check()

    def test_app_only_version_bump_does_not_invalidate_notices(self):
        for name in ["package.json", "package-lock.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock"]:
            path = self.root / name
            path.write_text(path.read_text().replace("1.0.0", "1.0.1"))
        self.check()

    def test_missing_mpl_source_fails(self):
        del self.manifest["packages"][0]["bundled_source"]
        for expression in ["MPL-2.0", "MPL-2.0 AND MIT", "MPL-2.0 OR MIT"]:
            self.manifest["packages"][0]["license"] = expression
            self.save_manifest()
            with self.subTest(license=expression), self.assertRaisesRegex(ValueError, "Missing MPL source"):
                self.check()

    def test_changed_source_fails_even_if_output_hash_is_updated(self):
        (self.root / self.source).write_bytes(b"different source")
        self.manifest["output_sha256"][self.source] = licenses.sha256(b"different source")
        self.save_manifest()
        with self.assertRaisesRegex(ValueError, "Archive checksum"):
            self.check()

    def test_unreviewed_asset_fails(self):
        (self.root / "public").mkdir()
        (self.root / "public/new.svg").write_text("unreviewed icon")
        with self.assertRaisesRegex(ValueError, "Assets changed"):
            self.check()

    def test_fonts_are_verified_separately_from_first_party_assets(self):
        font = self.root / "public/fonts/font.ttf"
        font.parent.mkdir(parents=True)
        font.write_bytes(b"font fixture")
        digest = licenses.sha256(font.read_bytes())
        record = {"first_party_assets_sha256": {}, "third_party_assets_sha256": {"public/fonts/font.ttf": digest}}
        self.write_json("third-party/provenance.json", record)
        self.write_json("third-party/supplements.json", {"assets": [{"binary_files": [{"path": "public/fonts/font.ttf", "sha256": digest}]}]})
        licenses.check_provenance(self.root)
        font.write_bytes(b"modified font")
        with self.assertRaisesRegex(ValueError, "Assets changed"):
            licenses.check_provenance(self.root)
        record["first_party_assets_sha256"] = record["third_party_assets_sha256"]
        self.write_json("third-party/provenance.json", record)
        with self.assertRaisesRegex(ValueError, "ownership overlaps"):
            licenses.check_provenance(self.root)

    def test_bundle_requires_every_notice_and_source(self):
        app = Path(self.temp.name) / "Fixture.app"
        resources = app / "Contents/Resources"
        shutil.copytree(self.root / "third-party", resources / "third-party")
        for name in ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.txt"]:
            shutil.copyfile(self.root / name, resources / name)
        with contextlib.redirect_stdout(io.StringIO()):
            licenses.check_bundle(self.root, app)
            for relative in ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.txt", self.source]:
                with self.subTest(file=relative):
                    target = resources / relative
                    data = target.read_bytes()
                    target.unlink()
                    with self.assertRaisesRegex(ValueError, "bundle licensing file"):
                        licenses.check_bundle(self.root, app)
                    target.write_bytes(b"changed")
                    with self.assertRaisesRegex(ValueError, "bundle licensing file"):
                        licenses.check_bundle(self.root, app)
                    target.write_bytes(data)

    def test_nested_vendored_notices_are_preserved_without_extracting(self):
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode="w:gz") as archive:
            for path, data in [("pkg/LICENSE", b"main"), ("pkg/vendor/lib/COPYING", b"vendor"),
                               ("pkg/icons/copyright.js", b"source code"),
                               ("pkg/../../escape", b"never extract")]:
                info = tarfile.TarInfo(path)
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
        self.assertEqual(licenses.archive_legal_files(stream.getvalue()),
                         {"LICENSE": "main", "vendor/lib/COPYING": "vendor"})

    def test_unreviewed_license_and_host_fail_closed(self):
        licenses.review_expression("MIT OR Apache-2.0")
        with self.assertRaisesRegex(ValueError, "requires review"):
            licenses.review_expression("Unreviewed-1.0")
        with self.assertRaisesRegex(ValueError, "Unreviewed package host"):
            licenses.download("https://example.com/source.tar.gz", "sha256-abc")

    def test_emitted_build_helpers_are_included_but_test_tools_are_not(self):
        packages = {"": {"name": "app"}}
        for name, dev in [("react", False), ("vite", True), ("vitest", True)]:
            packages["node_modules/" + name] = {"version": "1.0.0", "dev": dev,
                "license": "MIT", "integrity": "sha256-fixture", "resolved": "https://registry.npmjs.org/fixture"}
        self.write_json("package-lock.json", {"packages": packages})
        self.assertEqual({p["name"] for p in licenses.npm_packages(self.root)}, {"react", "vite"})

    def test_manifest_path_cannot_escape_repository(self):
        for path in ["../elsewhere", "/tmp/elsewhere"]:
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, "Unsafe relative path"):
                licenses.safe_path(self.root, path)

    def test_generate_refuses_changed_assets_before_network_access(self):
        (self.root / "public").mkdir()
        (self.root / "public/new.svg").write_text("unreviewed")
        with patch.object(licenses, "cargo_packages") as metadata:
            with self.assertRaisesRegex(ValueError, "Assets changed"):
                licenses.generate(self.root)
            metadata.assert_not_called()


if __name__ == "__main__":
    unittest.main()
