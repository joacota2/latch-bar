# Automated releases

Latch Bar uses Release Please for SemVer, changelog, tags, and draft GitHub Releases. The official Tauri action builds a universal macOS DMG and notarizes the application inside it. The release workflow then submits the final DMG to Apple, staples and verifies its ticket, replaces the draft asset with that final DMG, uploads its SHA-256 checksum, and publishes the release.

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

Create an environment named `macos-release` under **Settings → Environments** and restrict it to `main`. When the plan supports protected environments, add `joacota2` as the required reviewer, leave **Prevent self-review** disabled, and retain administrator bypass as a solo-maintainer recovery path.

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

Under **Settings → Actions → General**, keep the default `GITHUB_TOKEN` permissions read-only. Each workflow job explicitly requests only the additional permissions it needs.

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

## In-app updates

The installed macOS release checks GitHub Releases 30 seconds after launch and every six hours. Settings → General → Updates also supports an immediate check. Only **Update and restart** downloads and installs a release. Active agent turns, startup, pending approvals, and an open profile editor block installation; installation blocks new turns until it finishes or fails. Development builds and browser previews do not check for updates.

The stable endpoint is `https://github.com/joacota2/latch-bar/releases/latest/download/latest.json`. The repository must be public for anonymous downloads. Private-repository 404 responses are reported as failed checks, not as “up to date”. Never embed a GitHub token in the app. Existing users must manually install the first version containing this updater.

### Signing key setup and backup

The updater uses a separate signing key from Apple Developer ID. The public key is committed in `src-tauri/tauri.conf.json`; these private values belong in the `macos-release` GitHub environment:

| Secret | Value |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | Full contents of the Tauri updater private key |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password protecting that key |

The initial key and password were provisioned outside the repository at `~/.tauri/latch-bar/updater.key` and `~/.tauri/latch-bar/updater.password`, with owner-only permissions. The public copy is `updater.key.pub`. Back up the private key and password in a secure password manager: GitHub secrets cannot be downloaded, and replacing this key without a migration would strand existing installations.

For a new distribution only, generate keys using `npm run tauri signer generate -- -w /secure/path/updater.key`, then upload the key and password to the environment and commit only the public key. Do not regenerate the current distribution's key during ordinary releases.

### Release artifacts and validation

The workflow builds both the DMG and application bundle. It verifies the application's code signature, stapled notarization ticket, version, and both executable architectures. After all bundle mutations, it creates `Latch-Bar.app.tar.gz` and signs that exact archive. `scripts/updater-manifest.mjs` verifies the signature against the configured public key and creates `latest.json` for both `darwin-aarch64` and `darwin-x86_64`. Both entries use the same universal archive and version-specific URL.

The archive, `.sig`, and manifest are uploaded to the draft release and downloaded again to verify byte-for-byte correspondence. The release remains a draft if any check fails. Final DMG notarization and checksum verification still run before publication. Published versions remain immutable; ship a new higher version for a corrective release. Stable manifests reject prereleases.

### End-to-end acceptance before rollout

Use two increasing test versions of the app, signed with the same Apple identity and updater key. Build with a separate Tauri config overlay (`npm run tauri build -- --config /absolute/path/update-test.json`) overriding `version` and `plugins.updater.endpoints` to an HTTPS test manifest. The override is baked into that test build; do not alter the production endpoint or promote test releases to latest. Use a separate test hosting location or non-latest prereleases as artifact storage, with stable-format test version numbers in the test manifest. Keep test signing credentials outside source control.

On both an Intel Mac and an Apple Silicon Mac:

1. Install test version A into a writable Applications location. Create profiles and settings, enable Accessibility, and save history. Confirm there is no download until **Update and restart**.
2. Publish test version B to the isolated test endpoint. Confirm automatic/manual detection, notes, **Later**, installation, restart, and the new installed version. Verify profiles, settings, history, and Accessibility still work.
3. Repeat with a running agent, pending approval, a new turn starting, and an open profile editor. Installation must refuse without cancelling work. An idle Codex process must not block installation. Attempts to start or continue an agent while installing must fail with the updating explanation.
4. Test offline checks, interrupted downloads, corrupt archive/signature, and an unwritable installation location. A failure must not restart the app or report success; it must release the activity lock and offer retry. macOS may request authorization for protected install locations; verify rejection is handled.
5. Recheck installed version and retained data after restart. Do not claim either architecture validated until its actual install/update test passes.

Automated checks: `npm run check:version`, `npm test` (includes manifest/signature tests), `npm run build`, `cargo check --manifest-path src-tauri/Cargo.toml --locked`, and `cargo test --manifest-path src-tauri/Cargo.toml --locked`.
