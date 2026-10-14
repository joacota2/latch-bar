#!/usr/bin/env python3
"""Exercise the actual installer on disposable macOS volumes, never the running app."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--filesystem", choices=["APFS", "HFS+"], default="APFS")
    parser.add_argument("--archive", type=Path, help="Optional published app.tar.gz; requires adjacent .sig")
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("This regression harness requires macOS and hdiutil.")
    repo = Path(__file__).resolve().parent.parent
    env = os.environ.copy()
    if args.archive:
        archive = args.archive.resolve(strict=True)
        # Use the same pinned-key verification as release publication before testing
        # a real archive. Pass paths as arguments, never interpolate shell commands.
        subprocess.run([
            "node", "--input-type=module", "-e",
            "import {readFile} from 'node:fs/promises';"
            "import {verifyUpdateSignature} from './scripts/updater-manifest.mjs';"
            "const config=JSON.parse(await readFile('src-tauri/tauri.conf.json','utf8'));"
            "verifyUpdateSignature(await readFile(process.argv[1]),"
            "await readFile(process.argv[1]+'.sig','utf8'),config.plugins.updater.pubkey);"
            "console.log('Published archive: pinned-key signature verified.');",
            str(archive),
        ], cwd=repo, check=True)
        env["LATCH_UPDATER_TEST_ARCHIVE"] = str(archive)

    root = Path(tempfile.mkdtemp(prefix="latch-updater-regression-"))
    mount = root / "volume"
    image = root / "test.sparseimage"
    mounted = False

    def run_test(name):
        subprocess.run([
            "cargo", "test", "--manifest-path", "src-tauri/Cargo.toml", "--locked",
            f"update_installer::tests::{name}", "--", "--ignored", "--exact", "--nocapture",
        ], cwd=repo, env=env, check=True)

    try:
        subprocess.run([
            "hdiutil", "create", "-size", "256m", "-type", "SPARSE", "-fs", args.filesystem,
            "-volname", "Latch updater regression", str(image),
        ], check=True)
        subprocess.run(["hdiutil", "attach", "-nobrowse", "-mountpoint", str(mount), str(image)], check=True)
        mounted = True
        env["LATCH_UPDATER_TEST_VOLUME"] = str(mount)
        run_test("cross_volume_install")
        if args.archive:
            run_test("released_archive_install")
        fixture = mount / "ReadOnly.app"
        fixture.mkdir()
        (fixture / "original").write_text("old app")
        subprocess.run(["hdiutil", "detach", str(mount)], check=True)
        mounted = False
        subprocess.run(["hdiutil", "attach", "-readonly", "-nobrowse", "-mountpoint", str(mount), str(image)], check=True)
        mounted = True
        run_test("read_only_install")
    finally:
        if mounted:
            # If unmounting fails, leave the image and directory for recovery instead
            # of recursively deleting a still-mounted filesystem.
            subprocess.run(["hdiutil", "detach", str(mount)], check=True)
        shutil.rmtree(root)


if __name__ == "__main__":
    main()
