#!/usr/bin/env python3
"""Reproducible release attribution. Python 3.11+, stdlib only; never runs package code."""
import argparse
import base64
import concurrent.futures
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile
import tempfile
import time
import tomllib
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
TARGETS = ["aarch64-apple-darwin", "x86_64-apple-darwin"]
# Development packages can contribute runtime polyfills/helpers to the generated JS.
EMITTED_JS_TOOLS = {"vite", "rollup", "esbuild", "@vitejs/plugin-react", "@babel/runtime", "@babel/helpers"}
LEGAL = re.compile(r"^(licen[sc]e|copying|notice|copyright|unlicense|authors)([._-].*)?$", re.I)
INPUTS = ["package.json", "package-lock.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock",
          "third-party/supplements.json", "scripts/third-party.py", "src/styles.css",
          "third-party/provenance.json", "vite.config.ts"]
REVIEWED_TERMS = {"MIT", "Apache-2.0", "BSD-3-Clause", "BSD-2-Clause", "ISC", "MPL-2.0",
                  "Unicode-3.0", "BSL-1.0", "Zlib", "Unlicense", "0BSD", "MIT-0", "CC0-1.0",
                  "CDLA-Permissive-2.0", "LLVM-exception", "W3C-20150513"}


def review_expression(expression):
    terms = re.split(r"\s+(?:AND|OR|WITH)\s+|\s*/\s*", expression)
    if not terms or any(term.strip("() ") not in REVIEWED_TERMS for term in terms):
        raise ValueError(f"New license expression requires review: {expression}")


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def read_json(path):
    return json.loads(path.read_text())


def safe_path(root, relative):
    path = root / relative
    if Path(relative).is_absolute() or ".." in Path(relative).parts or not path.resolve().is_relative_to(root.resolve()):
        raise ValueError(f"Unsafe relative path: {relative}")
    return path


def validate_integrity(data, integrity):
    candidates = integrity.split()
    if not candidates:
        raise ValueError("Missing archive integrity")
    for candidate in candidates:
        algorithm, digest = candidate.split("-", 1)
        if algorithm not in ("sha256", "sha384", "sha512"):
            continue
        if base64.b64encode(hashlib.new(algorithm, data).digest()).decode() == digest:
            return
    raise ValueError("Archive checksum does not match the lockfile")


def download(url, integrity):
    if not url.startswith(("https://static.crates.io/crates/", "https://registry.npmjs.org/")):
        raise ValueError(f"Unreviewed package host: {url}")
    cache = Path(tempfile.gettempdir()) / "latch-license-cache"
    cache.mkdir(exist_ok=True)
    cached = cache / sha256(url.encode())
    if cached.exists():
        data = cached.read_bytes()
        validate_integrity(data, integrity)
        return data
    # Cargo already has authenticated-by-checksum package archives in most development checkouts.
    if url.startswith("https://static.crates.io/"):
        cargo_home = Path(os.environ.get("CARGO_HOME", str(Path.home() / ".cargo")))
        matches = list((cargo_home / "registry/cache").glob("*/" + url.rsplit("/", 1)[1]))
        if matches:
            data = matches[0].read_bytes()
            validate_integrity(data, integrity)
            return data
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=60) as response:
                data = response.read()
            validate_integrity(data, integrity)
            cached.write_bytes(data)
            return data
        except (OSError, TimeoutError):
            if attempt == 2:
                raise
            time.sleep(attempt + 1)


def archive_legal_files(data):
    """Read, never extract, legal documents, including nested vendored-library notices."""
    result = {}
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        for member in archive.getmembers():
            if not member.isfile():
                continue
            path = PurePosixPath(member.name)
            if LEGAL.match(path.name) and path.suffix.lower() not in (".rs", ".js", ".map", ".spdx"):
                if member.size > 2_000_000:
                    raise ValueError(f"Unexpectedly large legal file: {member.name}")
                text = archive.extractfile(member).read().decode("utf-8-sig")
                if text.strip():
                    result[str(PurePosixPath(*path.parts[1:]))] = text
    return dict(sorted(result.items()))


def cargo_packages(root):
    """Union both shipped architectures, including build dependencies; exclude dev-only edges."""
    selected = {}
    for target in TARGETS:
        metadata = json.loads(subprocess.check_output([
            "cargo", "metadata", "--locked", "--format-version", "1", "--filter-platform", target,
            "--manifest-path", str(root / "src-tauri/Cargo.toml")], text=True))
        nodes = {node["id"]: node for node in metadata["resolve"]["nodes"]}
        pending = [metadata["resolve"]["root"]]
        seen = set()
        while pending:
            current = pending.pop()
            if current in seen:
                continue
            seen.add(current)
            pending.extend(dep["pkg"] for dep in nodes[current]["deps"]
                           if any(kind["kind"] != "dev" for kind in dep["dep_kinds"]))
        for package in metadata["packages"]:
            if package["id"] in seen and package["id"] != metadata["resolve"]["root"]:
                if not (package.get("source") or "").startswith("registry+https://github.com/rust-lang/crates.io-index"):
                    raise ValueError(f"Review non-registry dependency: {package['id']}")
                selected[(package["name"], package["version"])] = package
    lock = tomllib.loads((root / "src-tauri/Cargo.lock").read_text())
    checksums = {(p["name"], p["version"]): p.get("checksum") for p in lock["package"]}
    result = []
    for key, package in sorted(selected.items()):
        name, version = key
        checksum = checksums[key]
        if not checksum or not package.get("license"):
            raise ValueError(f"Missing license/checksum: {key}")
        result.append({"id": f"cargo:{name}@{version}", "name": name, "version": version,
                       "ecosystem": "cargo", "license": package["license"],
                       "source": f"https://static.crates.io/crates/{name}/{name}-{version}.crate",
                       "integrity": "sha256-" + base64.b64encode(bytes.fromhex(checksum)).decode()})
    return result


def npm_packages(root):
    result = {}
    for path, package in read_json(root / "package-lock.json")["packages"].items():
        if not path:
            continue
        name = package.get("name") or path.rsplit("node_modules/", 1)[1]
        if (package.get("dev") or package.get("devOptional")) and name not in EMITTED_JS_TOOLS:
            continue
        if not package.get("license") or not package.get("integrity"):
            raise ValueError(f"Missing npm license/checksum: {name}")
        record = {"id": f"npm:{name}@{package['version']}", "name": name, "version": package["version"],
                  "ecosystem": "npm", "license": package["license"],
                  "source": package["resolved"], "integrity": package["integrity"]}
        if package.get("dev") or package.get("devOptional"):
            record["scope"] = "build tooling with potentially emitted runtime helpers"
        result[record["id"]] = record
    return list(result.values())


def supplement_files(root, entry):
    result = {}
    for item in entry.get("files", []):
        data = safe_path(root, item["path"]).read_bytes()
        if sha256(data) != item["sha256"]:
            raise ValueError(f"Changed supplemental license: {item['path']}")
        result[item["url"]] = data.decode("utf-8-sig")
    return result


def input_hashes(root):
    paths = INPUTS + [str(p.relative_to(root)) for p in sorted((root / "third-party/supplemental").glob("*.txt"))]
    return {p: sha256(attribution_input(root, p)) for p in paths}


def attribution_input(root, path):
    """Ignore only Latch Bar's own version, so Release Please can bump it automatically."""
    data = (root / path).read_bytes()
    if path in ("package.json", "package-lock.json"):
        value = json.loads(data)
        value.pop("version", None)
        if path == "package-lock.json":
            value["packages"][""].pop("version", None)
    elif path in ("src-tauri/Cargo.toml", "src-tauri/Cargo.lock"):
        value = tomllib.loads(data.decode())
        if path.endswith("Cargo.toml"):
            value["package"].pop("version", None)
        else:
            name = tomllib.loads((root / "src-tauri/Cargo.toml").read_text())["package"]["name"]
            for package in value["package"]:
                if package["name"] == name and "source" not in package:
                    package.pop("version", None)
    else:
        return data
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def generate(root):
    check_provenance(root)
    supplements = read_json(root / "third-party/supplements.json")
    packages = sorted(cargo_packages(root) + npm_packages(root), key=lambda p: p["id"])
    texts, sources = {}, {}

    def collect(package):
        review_expression(package["license"])
        data = download(package["source"], package["integrity"])
        files = archive_legal_files(data)
        extra = supplements["packages"].get(package["id"], {})
        files.update(supplement_files(root, extra))
        if not files:
            raise ValueError(f"No license text: {package['id']}; add a reviewed, version-specific supplement")
        package["notices"] = [{"origin": path, "text_sha256": sha256(text.encode())} for path, text in sorted(files.items())]
        if extra:
            package["review_note"] = extra["reason"]
        if "MPL-2.0" in package["license"]:
            package["bundled_source"] = f"third-party/sources/{package['name']}-{package['version']}.crate"
        return package, files, data

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        for package, files, data in pool.map(collect, packages):
            for text in files.values():
                texts[sha256(text.encode())] = text
            if package.get("bundled_source"):
                sources[package["bundled_source"]] = data
    assets = []
    for asset in supplements["assets"]:
        files = supplement_files(root, asset)
        if not files:
            raise ValueError(f"Missing asset license: {asset['name']}")
        item = {k: v for k, v in asset.items() if k != "files"}
        item["notices"] = []
        for origin, text in files.items():
            digest = sha256(text.encode())
            texts[digest] = text
            item["notices"].append({"origin": origin, "text_sha256": digest})
        assets.append(item)

    lines = ["Latch Bar — third-party licenses and notices", "",
             "Generated by scripts/third-party.py. Third-party works retain their own licenses.",
             "Scope: production npm packages, JS tools that may emit runtime helpers, and both",
             "macOS Cargo graphs, including",
             "build dependencies as a conservative superset. Inclusion is not a claim that every",
             "package is linked into the executable. Other distribution targets require a new review.", "",
             "MPL SOURCE ACCESS", "The complete, unmodified sources of the listed MPL-2.0 crates are included",
             "beside this file in third-party/sources/*.crate (gzip-compressed tar archives).",
             "In a macOS app, use Show Package Contents → Contents → Resources.",
             "Extract an archive with: tar -xzf package-version.crate",
             "These sources remain available under MPL 2.0, including their original notices.",
             "Exact upstream download URLs and lockfile checksums are listed below and in",
             "third-party/manifest.json. No private repository or login is needed to obtain them.", ""]
    for package in packages:
        lines += [package["id"], "License expression: " + package["license"], "Source: " + package["source"],
                  "Archive integrity: " + package["integrity"]]
        if package.get("bundled_source"):
            lines.append("Included MPL source: " + package["bundled_source"])
        if package.get("review_note"):
            lines.append("Review: " + package["review_note"])
        if package.get("scope"):
            lines.append("Scope: " + package["scope"])
        lines += [f"Notice {notice['text_sha256']} ({notice['origin']})" for notice in package["notices"]] + [""]
    for asset in assets:
        lines += ["Asset: " + asset["name"], "License: " + asset["license"], asset["delivery"]]
        lines += [f"Notice {notice['text_sha256']} ({notice['origin']})" for notice in asset["notices"]] + [""]
    lines += ["FULL LICENSE AND NOTICE TEXTS", "Identical texts are reproduced once; the index above maps each package to its texts.", ""]
    for digest, text in sorted(texts.items()):
        lines += ["=" * 72, "Notice " + digest, "=" * 72, text, ""]
    document = ("\n".join(lines) + "\n").encode()
    # Only write after all downloads and license checks succeed.
    source_dir = root / "third-party/sources"
    source_dir.mkdir(parents=True, exist_ok=True)
    for old in source_dir.glob("*.crate"):
        if str(old.relative_to(root)) not in sources:
            old.unlink()
    for path, data in sources.items():
        (root / path).write_bytes(data)
    (root / "THIRD_PARTY_NOTICES.txt").write_bytes(document)
    outputs = {"THIRD_PARTY_NOTICES.txt": sha256(document), **{p: sha256(b) for p, b in sources.items()}}
    manifest = {"schema": 1, "targets": TARGETS, "input_sha256": input_hashes(root),
                "output_sha256": outputs, "packages": packages, "assets": assets}
    (root / "third-party/manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    print(f"Generated notices for {len(packages)} packages, {len(assets)} fonts, and {len(sources)} MPL source archives.")


def check(root):
    manifest = read_json(root / "third-party/manifest.json")
    if manifest["schema"] != 1 or manifest["targets"] != TARGETS or manifest["input_sha256"] != input_hashes(root):
        raise ValueError("Attribution inputs changed; run npm run licenses:generate and review the result")
    for path, digest in manifest["output_sha256"].items():
        if sha256(safe_path(root, path).read_bytes()) != digest:
            raise ValueError(f"Missing or changed attribution output: {path}")
    for package in manifest["packages"]:
        if not package["notices"]:
            raise ValueError(f"Missing notices: {package['id']}")
        if "MPL-2.0" in package["license"]:
            path = package.get("bundled_source")
            if not path or path not in manifest["output_sha256"]:
                raise ValueError(f"Missing MPL source: {package['id']}")
            validate_integrity(safe_path(root, path).read_bytes(), package["integrity"])
    expected_sources = {p for p in manifest["output_sha256"] if p.startswith("third-party/sources/")}
    actual_sources = {str(p.relative_to(root)) for p in (root / "third-party/sources").glob("*.crate")}
    if actual_sources != expected_sources:
        raise ValueError("Unexpected or missing MPL source archives")
    check_provenance(root)
    print("Third-party attribution is current and checksums match.")


def check_provenance(root):
    provenance = read_json(root / "third-party/provenance.json")
    actual = {str(p.relative_to(root)): sha256(p.read_bytes())
              for directory in ["public", "src-tauri/icons", "docs/media"]
              for p in (root / directory).rglob("*") if p.is_file() and p.name != ".DS_Store"}
    third_party = provenance.get("third_party_assets_sha256", {})
    if set(third_party) & set(provenance["first_party_assets_sha256"]):
        raise ValueError("First-party and third-party asset ownership overlaps")
    fonts = {item["path"]: item["sha256"] for asset in read_json(root / "third-party/supplements.json")["assets"] for item in asset.get("binary_files", [])}
    if fonts != third_party:
        raise ValueError("Bundled font metadata does not match third-party provenance")
    if actual != {**provenance["first_party_assets_sha256"], **third_party}:
        raise ValueError("Assets changed: review their provenance and update third-party/provenance.json")


def check_bundle(root, app):
    check(root)
    resources = app / "Contents/Resources"
    expected = [root / p for p in ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.txt"]]
    expected += [p for p in (root / "third-party").rglob("*") if p.is_file()]
    for original in expected:
        relative = original.relative_to(root)
        bundled = safe_path(resources, str(relative))
        if not bundled.is_file() or bundled.read_bytes() != original.read_bytes():
            raise ValueError(f"Missing or changed bundle licensing file: {relative}")
    print(f"Verified {len(expected)} licensing files in {app.name}.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["generate", "check", "bundle"])
    parser.add_argument("app", nargs="?", type=Path)
    args = parser.parse_args()
    if args.mode == "generate":
        generate(ROOT)
    elif args.mode == "check":
        check(ROOT)
    elif args.app:
        check_bundle(ROOT, args.app)
    else:
        parser.error("bundle requires a .app path")
