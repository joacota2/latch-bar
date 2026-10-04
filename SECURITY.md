# Security policy

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/joacota2/latch-bar/security/advisories/new) to send a report to the maintainer. Do not put exploit details, tokens, private keys, or personal data in a public issue or pull request. A GitHub account is required to use this route.

Include the affected version, operating system, reproduction steps, expected impact, and a minimal example with secrets removed. Please allow time to investigate and coordinate a fix before public disclosure. This is a solo-maintained project; response times are not guaranteed.

## Supported versions

Security fixes are delivered in the latest stable macOS release. Older releases do not receive separate backports. Windows and Linux are not supported release targets yet.

## Distribution and credentials

Official downloads are published in [GitHub Releases](https://github.com/joacota2/latch-bar/releases). Public update checks and downloads do not need GitHub CLI or a GitHub token. Updates are verified against the app's pinned updater public key before installation. Apple signatures and notarization are checked during release.

Never commit signing credentials, API keys, exported keychains, or local environment files. GitHub push protection and the repository's secret-scanning checks provide additional safeguards; ignore rules alone are not protection against a forced add or an already tracked secret. If a real credential is exposed, revoke or rotate it before removing the committed copy.

Dependency advisory exceptions, their target scope, and review deadlines are recorded in `security/rust-advisories.json`. They do not establish that all application behavior is secure.
