#!/usr/bin/env python3
"""Reject tracked credential containers, including binaries a text scanner may skip."""
import re
import subprocess

SENSITIVE = re.compile(r"(^|/)(id_rsa|id_ed25519|id_ecdsa|id_dsa|updater\.password|[^/]+\.(p8|p12|pfx|key|pem|keychain|keychain-db|mobileprovision|provisionprofile))$", re.I)


def sensitive_paths(paths):
    return [path for path in paths if SENSITIVE.search(path)]


if __name__ == "__main__":
    paths = subprocess.check_output(["git", "ls-files", "-z"]).decode().split("\0")
    blocked = sensitive_paths(paths)
    if blocked:
        raise SystemExit("Remove tracked credential files: " + ", ".join(blocked))
    print("No tracked credential containers or private-key filenames.")
