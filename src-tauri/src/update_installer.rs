//! Installs an already signature-verified macOS updater archive.
//!
//! Keep staging beside the installed bundle, independently of TMPDIR. RENAME_SWAP
//! replaces the bundle atomically: on failure the old app never leaves its path;
//! on success it lives in staging until cleanup. Filesystems without directory
//! swaps use a durable backup with rollback, never an unprotected delete/move.
use flate2::read::GzDecoder;
use std::{
    ffi::CString,
    fs, io,
    os::unix::{ffi::OsStrExt, fs::PermissionsExt},
    path::{Component, Path, PathBuf},
};

const ARCHIVE_APP: &str = "Latch Bar.app";
const MANUAL_INSTALL: &str = "Download the latest Latch Bar installer, quit Latch, and replace the app in Applications. Your agents and settings are stored separately.";

pub fn install(verified_archive: &[u8]) -> Result<(), String> {
    let executable = tauri::utils::platform::current_exe().map_err(|error| error.to_string())?;
    let app = bundle_path(&executable).map_err(|error| format!("{error} {MANUAL_INSTALL}"))?;
    install_at(&app, verified_archive).map_err(|error| {
        format!("Automatic installation could not finish. {MANUAL_INSTALL} Details: {error}")
    })
}

fn bundle_path(executable: &Path) -> io::Result<PathBuf> {
    let macos = executable
        .parent()
        .ok_or_else(|| invalid("Missing executable directory"))?;
    let contents = macos
        .parent()
        .ok_or_else(|| invalid("Missing Contents directory"))?;
    let bundle = contents
        .parent()
        .ok_or_else(|| invalid("Missing app bundle"))?;
    if macos.file_name() != Some("MacOS".as_ref())
        || contents.file_name() != Some("Contents".as_ref())
        || bundle.extension() != Some("app".as_ref())
    {
        return Err(invalid("Updates require a packaged macOS application"));
    }
    fs::canonicalize(bundle)
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn install_at(app: &Path, verified_archive: &[u8]) -> io::Result<()> {
    install_with(app, verified_archive, swap_bundles)
}

fn install_with(
    app: &Path,
    verified_archive: &[u8],
    swap: impl FnOnce(&Path, &Path) -> io::Result<()>,
) -> io::Result<()> {
    // Canonicalization resolves a symlinked install location before choosing its volume.
    let app = fs::canonicalize(app)?;
    if !app.is_dir() {
        return Err(invalid("The installed bundle is not a directory"));
    }
    let parent = app
        .parent()
        .ok_or_else(|| invalid("Missing install directory"))?;
    let staging = tempfile::Builder::new()
        .prefix(".latch-update-")
        .tempdir_in(parent)?;
    let candidate = extract(verified_archive, staging.path())?;
    match swap(&candidate, &app) {
        Ok(()) => {}
        Err(error) if error.raw_os_error() == Some(libc::ENOTSUP) => {
            return replace_with_backup(staging, &candidate, &app, |from, to| fs::rename(from, to));
        }
        Err(error) => return Err(error),
    }
    // The swap is the commit point. A cleanup failure must not report an install
    // failure or remove the new bundle; leaving the old copy in staging is safe.
    if let Err(error) = staging.close() {
        eprintln!("Could not remove previous Latch update staging directory: {error}");
    }
    Ok(())
}

fn replace_with_backup(
    staging: tempfile::TempDir,
    candidate: &Path,
    app: &Path,
    mut rename: impl FnMut(&Path, &Path) -> io::Result<()>,
) -> io::Result<()> {
    // HFS+ cannot swap directories. Disarm TempDir cleanup BEFORE moving the old
    // bundle: even a panic or process crash must leave its only copy on disk.
    let staging = staging.keep();
    let backup = staging.join("previous.app");
    if let Err(error) = rename(app, &backup) {
        cleanup_backup(&staging);
        return Err(error);
    }
    if let Err(error) = rename(candidate, app) {
        if let Err(restore_error) = rename(&backup, app) {
            // Never delete this directory on error: it contains the original app.
            return Err(io::Error::other(format!(
                "Replacement failed ({error}); restoring the app also failed ({restore_error}). The previous app is preserved at {}. Quit Latch before moving it back to {}.",
                backup.display(), app.display()
            )));
        }
        cleanup_backup(&staging);
        return Err(io::Error::new(
            error.kind(),
            format!("{error}. The previous app was restored."),
        ));
    }
    cleanup_backup(&staging);
    Ok(())
}

fn cleanup_backup(staging: &Path) {
    if let Err(error) = fs::remove_dir_all(staging) {
        eprintln!(
            "Could not remove Latch update staging directory {}: {error}",
            staging.display()
        );
    }
}

fn extract(bytes: &[u8], staging: &Path) -> io::Result<PathBuf> {
    let mut archive = tar::Archive::new(GzDecoder::new(bytes));
    for entry in archive.entries()? {
        let mut entry = entry?;
        let path = entry.path()?;
        let mut components = path.components();
        if components.next() != Some(Component::Normal(ARCHIVE_APP.as_ref()))
            || components.any(|part| !matches!(part, Component::Normal(_)))
        {
            return Err(invalid("Unexpected path in the update archive"));
        }
        // Official bundles contain regular files and directories only. Reject links
        // and special files so extraction cannot write outside the private staging dir.
        let kind = entry.header().entry_type();
        if !kind.is_file() && !kind.is_dir() {
            return Err(invalid("Unsupported file type in the update archive"));
        }
        if !entry.unpack_in(staging)? {
            return Err(invalid("Update archive path escapes staging"));
        }
    }
    let candidate = staging.join(ARCHIVE_APP);
    let executable = candidate.join("Contents/MacOS/latch-bar");
    let metadata = fs::metadata(&executable)?;
    if !metadata.is_file()
        || metadata.permissions().mode() & 0o111 == 0
        || !candidate.join("Contents/Info.plist").is_file()
    {
        return Err(invalid(
            "The update does not contain a complete executable app bundle",
        ));
    }
    Ok(candidate)
}

fn swap_bundles(candidate: &Path, installed: &Path) -> io::Result<()> {
    let candidate = CString::new(candidate.as_os_str().as_bytes())?;
    let installed = CString::new(installed.as_os_str().as_bytes())?;
    // SAFETY: both C strings remain alive for the call. RENAME_SWAP atomically
    // exchanges existing paths on macOS 10.12+, below our minimum macOS version.
    let result =
        unsafe { libc::renamex_np(candidate.as_ptr(), installed.as_ptr(), libc::RENAME_SWAP) };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{write::GzEncoder, Compression};

    fn archive(executable: bool) -> Vec<u8> {
        let mut archive = tar::Builder::new(GzEncoder::new(Vec::new(), Compression::default()));
        for (path, content, mode) in [
            ("Latch Bar.app/Contents/Info.plist", "test plist", 0o644),
            (
                "Latch Bar.app/Contents/MacOS/latch-bar",
                "new executable",
                if executable { 0o755 } else { 0o644 },
            ),
        ] {
            let mut header = tar::Header::new_gnu();
            header.set_size(content.len() as u64);
            header.set_mode(mode);
            header.set_cksum();
            archive
                .append_data(&mut header, path, content.as_bytes())
                .unwrap();
        }
        archive.into_inner().unwrap().finish().unwrap()
    }

    fn installed(root: &Path) -> PathBuf {
        let app = root.join("Renamed Latch's app.app");
        fs::create_dir(&app).unwrap();
        fs::write(app.join("original"), "old app").unwrap();
        app
    }

    #[test]
    fn replaces_the_bundle_atomically_and_preserves_unrelated_data() {
        let root = tempfile::tempdir().unwrap();
        let app = installed(root.path());
        fs::write(root.path().join("settings.json"), "keep").unwrap();
        install_at(&app, &archive(true)).unwrap();
        assert_eq!(
            fs::read_to_string(app.join("Contents/MacOS/latch-bar")).unwrap(),
            "new executable"
        );
        assert!(!app.join("original").exists());
        assert_eq!(
            fs::read_to_string(root.path().join("settings.json")).unwrap(),
            "keep"
        );
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 2);
    }

    #[test]
    fn failed_swap_keeps_the_original_and_cleans_staging() {
        let root = tempfile::tempdir().unwrap();
        let app = installed(root.path());
        let result = install_with(&app, &archive(true), |candidate, target| {
            assert!(candidate.join("Contents/MacOS/latch-bar").exists());
            assert!(target.join("original").exists());
            Err(io::Error::from_raw_os_error(libc::EACCES))
        });
        assert_eq!(result.unwrap_err().raw_os_error(), Some(libc::EACCES));
        assert_eq!(fs::read_to_string(app.join("original")).unwrap(), "old app");
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
    }

    #[test]
    fn invalid_archives_never_replace_the_original() {
        let root = tempfile::tempdir().unwrap();
        let app = installed(root.path());
        for bytes in [b"not an archive".to_vec(), archive(false)] {
            assert!(install_at(&app, &bytes).is_err());
            assert_eq!(fs::read_to_string(app.join("original")).unwrap(), "old app");
            assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
        }
    }

    #[test]
    fn unsupported_swaps_use_the_backup_fallback() {
        let root = tempfile::tempdir().unwrap();
        let app = installed(root.path());
        install_with(&app, &archive(true), |_, _| {
            Err(io::Error::from_raw_os_error(libc::ENOTSUP))
        })
        .unwrap();
        assert!(app.join("Contents/MacOS/latch-bar").exists());
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
    }

    #[test]
    fn fallback_restores_original_or_retains_backup_if_restore_fails() {
        for fail_restore in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let app = installed(root.path());
            let staging = tempfile::tempdir_in(root.path()).unwrap();
            let staging_path = staging.path().to_owned();
            let candidate = extract(&archive(true), staging.path()).unwrap();
            let mut calls = 0;
            let error = replace_with_backup(staging, &candidate, &app, |from, to| {
                calls += 1;
                if calls == 2 || (calls == 3 && fail_restore) {
                    Err(io::Error::from_raw_os_error(libc::EIO))
                } else {
                    fs::rename(from, to)
                }
            })
            .unwrap_err();
            assert_eq!(calls, 3);
            if fail_restore {
                let backup = staging_path.join("previous.app");
                assert_eq!(
                    fs::read_to_string(backup.join("original")).unwrap(),
                    "old app"
                );
                assert!(error.to_string().contains(&backup.display().to_string()));
                assert!(!app.exists());
            } else {
                assert_eq!(fs::read_to_string(app.join("original")).unwrap(), "old app");
                assert!(!staging_path.exists());
                assert!(error.to_string().contains("restored"));
            }
        }
    }

    #[test]
    fn fallback_keeps_backup_on_interruption() {
        let root = tempfile::tempdir().unwrap();
        let app = installed(root.path());
        let staging = tempfile::tempdir_in(root.path()).unwrap();
        let staging_path = staging.path().to_owned();
        let candidate = extract(&archive(true), staging.path()).unwrap();
        let mut calls = 0;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            replace_with_backup(staging, &candidate, &app, |from, to| {
                calls += 1;
                if calls == 2 {
                    panic!("simulated interruption after backup");
                }
                fs::rename(from, to)
            })
        }));
        assert!(result.is_err());
        assert_eq!(
            fs::read_to_string(staging_path.join("previous.app/original")).unwrap(),
            "old app"
        );
    }

    #[test]
    fn rejects_links_and_unexpected_archive_roots() {
        let root = tempfile::tempdir().unwrap();
        let app = installed(root.path());
        for path in ["Latch Bar.app/escape", "Other.app/escape"] {
            let mut archive = tar::Builder::new(GzEncoder::new(Vec::new(), Compression::default()));
            let mut header = tar::Header::new_gnu();
            header.set_mode(0o777);
            header.set_size(0);
            header.set_entry_type(tar::EntryType::Symlink);
            archive
                .append_link(&mut header, path, root.path().join("outside"))
                .unwrap();
            let bytes = archive.into_inner().unwrap().finish().unwrap();
            assert!(install_at(&app, &bytes).is_err());
            assert!(app.join("original").exists());
            assert!(!root.path().join("outside").exists());
        }
    }

    #[test]
    fn resolves_installed_bundle_and_rejects_unbundled_executables() {
        let root = tempfile::tempdir().unwrap();
        let app = installed(root.path());
        assert_eq!(
            bundle_path(&app.join("Contents/MacOS/latch-bar")).unwrap(),
            fs::canonicalize(&app).unwrap()
        );
        assert!(bundle_path(Path::new("/usr/local/bin/latch-bar")).is_err());
    }

    // The harness supplies a disposable mounted volume. Never target a real app.
    #[test]
    #[ignore = "requires LATCH_UPDATER_TEST_VOLUME on a separate writable volume"]
    fn cross_volume_install() {
        use std::os::unix::fs::MetadataExt;
        let volume = std::env::var_os("LATCH_UPDATER_TEST_VOLUME").expect("test volume");
        let root = tempfile::tempdir_in(volume).unwrap();
        let system_temp = tempfile::tempdir().unwrap();
        assert_ne!(
            fs::metadata(root.path()).unwrap().dev(),
            fs::metadata(system_temp.path()).unwrap().dev()
        );
        let app = installed(root.path());
        let error = fs::rename(&app, system_temp.path().join("old-plugin-backup")).unwrap_err();
        assert_eq!(error.raw_os_error(), Some(libc::EXDEV));
        assert!(app.join("original").exists());
        install_at(&app, &archive(true)).unwrap();
        assert!(app.join("Contents/MacOS/latch-bar").exists());
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
        println!("Old cross-volume rename: EXDEV. New same-volume installation: succeeded.");
    }

    #[test]
    #[ignore = "requires a disposable read-only volume from the macOS test harness"]
    fn read_only_install() {
        let volume = std::env::var_os("LATCH_UPDATER_TEST_VOLUME").expect("test volume");
        let app = Path::new(&volume).join("ReadOnly.app");
        let error = install_at(&app, &archive(true)).unwrap_err();
        // tempfile adds path context, retaining the kind rather than raw_os_error.
        assert_eq!(error.kind(), io::ErrorKind::ReadOnlyFilesystem);
        assert_eq!(fs::read_to_string(app.join("original")).unwrap(), "old app");
        println!("Read-only installation: refused; original bundle preserved.");
    }

    #[test]
    #[ignore = "requires a signature-verified release archive and disposable volume"]
    fn released_archive_install() {
        let volume = std::env::var_os("LATCH_UPDATER_TEST_VOLUME").expect("test volume");
        let archive = std::env::var_os("LATCH_UPDATER_TEST_ARCHIVE").expect("verified archive");
        let root = tempfile::tempdir_in(volume).unwrap();
        let app = installed(root.path());
        install_at(&app, &fs::read(archive).unwrap()).unwrap();
        assert!(std::process::Command::new("/usr/bin/codesign")
            .args(["--verify", "--deep", "--strict"])
            .arg(&app)
            .status()
            .unwrap()
            .success());
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
        println!("Published release installed; Apple code signature remains valid.");
    }
}
