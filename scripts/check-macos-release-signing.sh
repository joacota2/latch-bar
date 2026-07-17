#!/bin/sh
set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  exit 0
fi

identity="${APPLE_SIGNING_IDENTITY:-}"
if [ -z "$identity" ]; then
  echo "macOS release bundles must be signed so Accessibility permission survives app updates." >&2
  echo "Set APPLE_SIGNING_IDENTITY to an Apple Development or Developer ID Application identity." >&2
  echo "Use 'tauri build --no-bundle' when you only need an unsigned compile check." >&2
  exit 1
fi

if ! security find-identity -v -p codesigning | grep -F "$identity" >/dev/null; then
  echo "APPLE_SIGNING_IDENTITY does not match a valid code-signing identity in the keychain." >&2
  exit 1
fi
