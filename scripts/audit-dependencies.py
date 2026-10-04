#!/usr/bin/env python3
"""Fail on new Rust advisories; narrowly scope reviewed exceptions to exact packages."""
from datetime import date
import importlib.util
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent.parent


def assess(report, policy, macos_packages, today=None):
    today = today or date.today()
    settings = report["settings"]
    if any(settings.get(key) for key in ["ignore", "target_arch", "target_os", "severity"]):
        raise ValueError("Rust audit must not filter advisories before policy review")
    if not {"unmaintained", "unsound", "notice"}.issubset(settings["informational_warnings"]):
        raise ValueError("Rust audit must include informational advisories")
    if policy["schema"] != 1:
        raise ValueError("Unsupported advisory policy")
    exceptions = {}
    for item in policy["exceptions"]:
        key = (item["id"], item["package"], item["version"], item["kind"])
        if key in exceptions or not item["reason"].strip():
            raise ValueError("Duplicate or undocumented exception")
        if date.fromisoformat(item["review_by"]) <= today:
            raise ValueError(f"Expired exception: {item['id']}")
        exceptions[key] = item
    findings = [("vulnerability", item) for item in report["vulnerabilities"]["list"]]
    if report["vulnerabilities"]["count"] != len(findings):
        raise ValueError("Inconsistent vulnerability report")
    findings += [(kind, item) for kind, items in report["warnings"].items() for item in items]
    seen, accepted = set(), []
    for kind, finding in findings:
        package, advisory = finding["package"], finding["advisory"]
        key = (advisory["id"], package["name"], package["version"], kind)
        item = exceptions.get(key)
        if item is None or package["source"] != "registry+https://github.com/rust-lang/crates.io-index":
            raise ValueError(f"Unreviewed advisory: {key}")
        scope = item["scope"]
        if scope == "non-macos":
            if (package["name"], package["version"]) in macos_packages:
                raise ValueError(f"Non-macOS exception now affects a shipped target: {key}")
        elif scope != "upstream-maintenance" or kind != "unmaintained":
            raise ValueError(f"Invalid exception scope: {key}")
        seen.add(key)
        accepted.append(f"{advisory['id']}: {package['name']} {package['version']} ({scope}; review by {item['review_by']})")
    if set(exceptions) != seen:
        raise ValueError("Remove stale advisory exceptions that no longer match the lockfile/report")
    return accepted


def main():
    audit = subprocess.run(["cargo", "audit", "--file", str(ROOT / "src-tauri/Cargo.lock"), "--json"],
                           cwd=ROOT, capture_output=True, text=True, timeout=180)
    if audit.returncode not in (0, 1):
        raise RuntimeError(audit.stderr)
    report = json.loads(audit.stdout)
    if "error" in report:
        raise RuntimeError(f"Cargo audit failed: {report['error']}")
    # Reuse the same live graph traversal as attribution: both architectures,
    # including build dependencies, without relying on a stale manifest.
    spec = importlib.util.spec_from_file_location("third_party", ROOT / "scripts/third-party.py")
    attribution = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(attribution)
    macos = {(p["name"], p["version"]) for p in attribution.cargo_packages(ROOT)}
    accepted = assess(report, json.loads((ROOT / "security/rust-advisories.json").read_text()), macos)
    for line in accepted:
        print("Reviewed exception:", line)
    print(f"Rust advisory check passed with {len(accepted)} explicitly reviewed exceptions.")


if __name__ == "__main__":
    main()
