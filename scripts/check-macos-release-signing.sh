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

if [ "${LATCH_REQUIRE_NOTARIZED_RELEASE:-0}" = "1" ]; then
  case "$identity" in
    "Developer ID Application: "*) ;;
    *)
      echo "Public macOS releases must use a Developer ID Application identity." >&2
      exit 1
      ;;
  esac

  if [ -z "${APPLE_API_ISSUER:-}" ] || [ -z "${APPLE_API_KEY:-}" ] || [ -z "${APPLE_API_KEY_PATH:-}" ]; then
    echo "Public macOS releases require App Store Connect API credentials for notarization." >&2
    exit 1
  fi

  if [ ! -f "$APPLE_API_KEY_PATH" ]; then
    echo "APPLE_API_KEY_PATH does not point to a readable App Store Connect private key." >&2
    exit 1
  fi
fi

if ! security find-identity -v -p codesigning | grep -F "\"$identity\"" >/dev/null; then
  echo "APPLE_SIGNING_IDENTITY does not match a valid code-signing identity in the keychain." >&2
  exit 1
fi
