# Automated releases

Latch Bar uses Release Please for SemVer, changelog, tags, and draft GitHub Releases. The official Tauri action builds a universal macOS DMG, signs it with Developer ID, notarizes and staples it, verifies it, uploads `Latch-Bar.dmg` and its SHA-256 checksum, and then publishes the draft.

## One-time Apple setup

A paid Apple Developer Program membership is required for Developer ID notarization.

1. Create a **Developer ID Application** certificate in Apple Developer Certificates, Identifiers & Profiles. Install it in Keychain Access, expand the certificate to confirm its private key is present, and export it as a password-protected `.p12` file.
2. Copy the base64-encoded certificate for GitHub:

   ```bash
   openssl base64 -A -in DeveloperIDApplication.p12 | pbcopy
   ```

3. In App Store Connect, open **Users and Access → Integrations**, create a team API key with the Developer role, record its Issuer ID and Key ID, and download its `.p8` private key. Apple only offers the private-key download once.
4. Copy the base64-encoded API private key:

   ```bash
   openssl base64 -A -in AuthKey_KEYID.p8 | pbcopy
   ```

The exact signing identity for `APPLE_SIGNING_IDENTITY` is shown by:

```bash
security find-identity -v -p codesigning
```

It must begin with `Developer ID Application: `.

## One-time GitHub setup

### Release Please token

Create a fine-grained personal access token restricted to this repository, with an expiration date and these repository permissions:

- Contents: Read and write
- Issues: Read and write
- Pull requests: Read and write

Add it under **Settings → Secrets and variables → Actions → Repository secrets** as:

```text
RELEASE_PLEASE_TOKEN
```

Release Please uses this token so its generated release pull request triggers the normal pull-request CI. Keep the token scoped only to this repository and rotate it before it expires.

### macOS release environment

Create an environment named `macos-release` under **Settings → Environments**. Restrict it to `main`. When the plan supports protected environments, add a required reviewer and disable administrator bypass.

Add these environment secrets:

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | Base64-encoded Developer ID Application `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | Password used when exporting the `.p12` |
| `APPLE_SIGNING_IDENTITY` | Full Developer ID Application identity |
| `APPLE_API_ISSUER` | App Store Connect API Issuer ID |
| `APPLE_API_KEY` | App Store Connect API Key ID |
| `APPLE_API_PRIVATE_KEY` | Base64-encoded App Store Connect `.p8` |

If the current private-repository plan does not support environment secrets, create the `macos-release` environment without protection and store the Apple values as repository Actions secrets with the same names. The workflow does not change. Move them to protected environment secrets and add a required reviewer when the repository becomes public.

Under **Settings → Actions → General**, allow GitHub Actions to use read and write workflow permissions. The workflows still declare narrower permissions per job.

Protect `main` with pull requests and require the `CI / Verify` check. Prefer squash merges. If this is a solo repository, requiring a separate approving reviewer can prevent the Release Please pull request from being merged; enable required reviews when another maintainer is available.

## Normal release flow

1. Give pull requests Conventional Commit titles such as `fix: ...`, `feat: ...`, or `feat!: ...` and squash-merge them into `main`.
2. Release Please creates or updates its release pull request. It synchronizes `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and `src-tauri/Cargo.lock`, and generates `CHANGELOG.md`.
3. Merge the release pull request when that set of changes is ready to ship.
4. Release Please creates the version tag and a draft GitHub Release. The protected macOS job builds and verifies the release, then publishes it automatically.

The stable download URL is:

```text
https://github.com/joacota2/latch-bar/releases/latest/download/Latch-Bar.dmg
```

If the macOS job fails after creating the draft, rerun the failed job. Alternatively, run the **Release** workflow manually and provide the existing draft tag. The workflow deliberately refuses to overwrite an already published release.

## Public-repository hardening

Before making the repository public:

- Move all Apple credentials to the protected `macos-release` environment.
- Require approval for all outside-contributor workflow runs.
- Require review for changes to workflows and release configuration when another maintainer is available.
- Continue pinning Actions to immutable commit SHAs.
- Never add Apple credentials to pull-request workflows; fork pull requests must remain secret-free.
