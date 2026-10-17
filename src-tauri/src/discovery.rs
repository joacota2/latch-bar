//! Bounded version probes, shared by status, catalog discovery and launches.
use std::{
    fs,
    io::Read,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{mpsc, Mutex, OnceLock},
    time::{Duration, Instant},
};
#[derive(Clone, Debug, serde::Serialize)]
pub struct RuntimeProbe {
    pub path: String,
    pub detail: String,
}
#[derive(Clone, Debug)]
pub struct Resolution {
    pub path: Option<PathBuf>,
    pub version: Option<String>,
    pub source: &'static str,
    pub diagnostics: Vec<RuntimeProbe>,
}
impl Resolution {
    pub fn executable(&self) -> Result<&PathBuf, String> {
        if self.version.is_some() {
            if let Some(path) = &self.path {
                return Ok(path);
            }
        }
        if self.source == "override" {
            return Err(self
                .diagnostics
                .first()
                .map(|probe| probe.detail.clone())
                .unwrap_or_else(|| "Invalid CODEX_BIN override".into()));
        }
        Err("No working Codex installation responded. Install Codex or check again.".into())
    }
}
struct Cached {
    resolution: Resolution,
    at: Instant,
    context: String,
}
static CACHE: OnceLock<Mutex<Option<Cached>>> = OnceLock::new();
pub fn invalidate() {
    if let Ok(mut cache) = CACHE.get_or_init(Default::default).lock() {
        *cache = None;
    }
}
fn terminate(child: &mut Child) {
    #[cfg(unix)]
    unsafe {
        extern "C" {
            fn kill(pid: i32, signal: i32) -> i32;
        }
        // Each version probe starts its own process group; never target the app's group.
        kill(-(child.id() as i32), 9);
    }
    let _ = child.kill();
    let _ = child.wait();
}
fn probe(mut command: Command, deadline: Instant) -> Result<String, String> {
    if Instant::now() >= deadline {
        return Err("Discovery deadline reached".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Could not run --version: {error}"))?;
    let stdout = child.stdout.take().expect("piped stdout");
    let (send, receive) = mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.take(8192).read_to_end(&mut bytes);
        let _ = send.send(bytes);
    });
    let expires = deadline.min(Instant::now() + Duration::from_secs(2));
    let outcome = loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                break if status.success() {
                    Ok(())
                } else {
                    Err(format!("Version check failed ({status})"))
                }
            }
            Err(error) => break Err(format!("Version check failed: {error}")),
            _ => {}
        }
        if Instant::now() >= expires {
            break Err("Version check timed out after at most two seconds".into());
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    terminate(&mut child);
    outcome?;
    let output = receive
        .recv_timeout(expires.saturating_duration_since(Instant::now()))
        .map_err(|_| "Version output unavailable")?;
    let version = String::from_utf8_lossy(&output)
        .trim()
        .trim_start_matches("codex-cli ")
        .to_string();
    if crate::scanner::parse_codex_version(version.as_bytes()).len() < 3 {
        return Err("Version check did not return a Codex version".into());
    }
    Ok(version)
}
// Probe all candidates within one deadline/concurrency budget, retaining input order
// for diagnostic display and ties between an app launcher and its nested binary.
fn scan(
    candidates: Vec<PathBuf>,
    directories: &[PathBuf],
) -> Vec<(PathBuf, Result<String, String>)> {
    let deadline = Instant::now() + Duration::from_secs(10);
    let pending = Mutex::new(candidates.iter().enumerate());
    let found = Mutex::new(Vec::new());
    std::thread::scope(|scope| {
        for _ in 0..4 {
            scope.spawn(|| {
                while let Some((index, path)) = pending
                    .lock()
                    .ok()
                    .and_then(|mut candidates| candidates.next())
                {
                    let result = if !path.is_file() {
                        Err("Not found".into())
                    } else {
                        probe(
                            crate::scanner::command_for_executable(path, directories),
                            deadline,
                        )
                    };
                    found.lock().unwrap().push((index, path.clone(), result));
                }
            });
        }
    });
    let mut found = found.into_inner().unwrap();
    found.sort_by_key(|(index, _, _)| *index);
    found
        .into_iter()
        .map(|(_, path, result)| (path, result))
        .collect()
}
pub fn select(
    bundled: Vec<PathBuf>,
    candidates: Vec<PathBuf>,
    directories: &[PathBuf],
    configured: Option<PathBuf>,
) -> Resolution {
    let override_mode = configured.is_some();
    let bundle_count = if override_mode { 0 } else { bundled.len() };
    let paths = if let Some(path) = configured {
        vec![path]
    } else {
        bundled.into_iter().chain(candidates).collect()
    };
    let results = scan(paths, directories);
    let mut selected: Option<(usize, Vec<u64>)> = None;
    for (index, (_, result)) in results.iter().enumerate() {
        if let Ok(version) = result {
            let rank = crate::scanner::parse_codex_version(version.as_bytes());
            if selected.as_ref().is_none_or(|(current, current_rank)| {
                (index < bundle_count && *current >= bundle_count)
                    || ((index < bundle_count) == (*current < bundle_count) && rank > *current_rank)
            }) {
                selected = Some((index, rank));
            }
        }
    }
    let source = if override_mode {
        "override"
    } else if selected
        .as_ref()
        .is_some_and(|(index, _)| *index < bundle_count)
    {
        "desktop-app"
    } else {
        "cli"
    };
    let chosen = selected.as_ref().map(|(index, _)| &results[*index]);
    Resolution {
        path: chosen
            .map(|(path, _)| path.clone())
            .or_else(|| override_mode.then(|| results[0].0.clone())),
        version: chosen.and_then(|(_, result)| result.as_ref().ok().cloned()),
        source,
        diagnostics: results
            .iter()
            .map(|(path, result)| RuntimeProbe {
                path: path.to_string_lossy().into_owned(),
                detail: match result {
                    Ok(version) if override_mode => format!("CODEX_BIN override: Codex {version}"),
                    Ok(version) => format!("Found Codex {version}"),
                    Err(error) if override_mode => format!(
                        "CODEX_BIN {}: {error}. Fix or remove the override.",
                        path.display()
                    ),
                    Err(error) => error.clone(),
                },
            })
            .collect(),
    }
}
pub fn resolve(
    bundled: Vec<PathBuf>,
    candidates: Vec<PathBuf>,
    directories: &[PathBuf],
    configured: Option<PathBuf>,
    force: bool,
) -> Result<Resolution, String> {
    let requested_at = Instant::now();
    // Watch every candidate, including missing/unselected app layouts. An app update
    // or newly installed bundle must invalidate a previously selected CLI's cache.
    let fingerprints = bundled
        .iter()
        .chain(&candidates)
        .chain(configured.iter())
        .map(|path| {
            let metadata = fs::metadata(path).ok();
            (
                path,
                fs::canonicalize(path).ok(),
                metadata.as_ref().and_then(|data| data.modified().ok()),
                metadata.map(|data| data.len()),
            )
        })
        .collect::<Vec<_>>();
    let context = format!("{directories:?}:{configured:?}:{fingerprints:?}");
    let mut guard = CACHE
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "Runtime discovery unavailable")?;
    if let Some(cache) = guard.as_ref() {
        if cache.context == context
            && (cache.at >= requested_at
                || (cache.resolution.version.is_some()
                    && !force
                    && cache.at.elapsed() < Duration::from_secs(300)))
        {
            return Ok(cache.resolution.clone());
        }
    }
    let resolution = select(bundled, candidates, directories, configured);
    *guard = Some(Cached {
        resolution: resolution.clone(),
        at: Instant::now(),
        context,
    });
    Ok(resolution)
}
#[cfg(test)]
pub fn newest(candidates: Vec<PathBuf>, directories: &[PathBuf]) -> Option<Resolution> {
    let resolution = select(Vec::new(), candidates, directories, None);
    resolution.version.as_ref()?;
    Some(resolution)
}
#[cfg(test)]
mod tests {
    use super::*;
    static SERIAL_CACHE_TEST: Mutex<()> = Mutex::new(());
    #[test]
    #[cfg(unix)]
    fn hung_probe_does_not_hide_a_working_installation() {
        let _serial = SERIAL_CACHE_TEST.lock().unwrap();
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&root).unwrap();
        for (name, script) in [
            ("hung", "sleep 60"),
            ("good", "echo codex-cli 1.2.3"),
            ("broken", "exit 1"),
        ] {
            let path = root.join(name);
            fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let started = Instant::now();
        let found = newest(
            vec![root.join("hung"), root.join("good"), root.join("broken")],
            &[PathBuf::from("/bin")],
        )
        .unwrap();
        assert_eq!(found.path, Some(root.join("good")));
        assert!(started.elapsed() < Duration::from_secs(4));
        assert!(resolve(
            vec![],
            vec![root.join("good")],
            &[],
            Some(root.join("missing")),
            true
        )
        .unwrap()
        .executable()
        .unwrap_err()
        .contains("CODEX_BIN"));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    #[cfg(unix)]
    fn cached_cli_yields_to_new_bundles_and_unselected_app_updates() {
        use std::os::unix::fs::PermissionsExt;
        let _serial = SERIAL_CACHE_TEST.lock().unwrap();
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&root).unwrap();
        let cli = root.join("cli");
        let launcher = root.join("launcher");
        let nested = root.join("nested");
        let write_version = |path: &PathBuf, version: &str| {
            fs::write(path, format!("#!/bin/sh\necho 'codex-cli {version}'\n")).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        };
        let discover = || {
            resolve(
                vec![launcher.clone(), nested.clone()],
                vec![cli.clone()],
                &[],
                None,
                false,
            )
            .unwrap()
        };
        write_version(&cli, "9.0.0");
        assert_eq!(discover().path, Some(cli.clone()));
        write_version(&launcher, "1.0.0");
        write_version(&nested, "1.0.0");
        // Prefer the desktop app even over a newer CLI; on ties use its launcher.
        assert_eq!(discover().path, Some(launcher.clone()));
        write_version(&nested, "2.0.0-alpha.10");
        assert_eq!(discover().path, Some(nested.clone()));
        fs::remove_file(&nested).unwrap();
        fs::remove_file(&launcher).unwrap();
        assert_eq!(discover().path, Some(cli));
        invalidate();
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    #[cfg(unix)]
    fn cache_shares_success_and_refreshes_expired_changed_and_invalidated_executables() {
        use std::os::unix::fs::PermissionsExt;
        let _serial = SERIAL_CACHE_TEST.lock().unwrap();
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&root).unwrap();
        let path = root.join("codex");
        let count = root.join("count");
        let script = format!(
            "#!/bin/sh\necho x >> '{}'\necho codex-cli 1.2.3\n",
            count.display()
        );
        fs::write(&path, &script).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        let discover = || resolve(vec![], vec![path.clone()], &[], None, false).unwrap();
        invalidate();
        std::thread::scope(|scope| {
            for _ in 0..4 {
                scope.spawn(discover);
            }
        });
        assert_eq!(fs::read_to_string(&count).unwrap().lines().count(), 1);
        CACHE.get().unwrap().lock().unwrap().as_mut().unwrap().at -= Duration::from_secs(301);
        discover();
        assert_eq!(fs::read_to_string(&count).unwrap().lines().count(), 2);
        resolve(vec![], vec![path.clone()], &[], None, true).unwrap();
        invalidate();
        discover();
        fs::write(&path, format!("{script}# changed executable\n")).unwrap();
        discover();
        assert_eq!(fs::read_to_string(&count).unwrap().lines().count(), 5);
        invalidate();
        fs::remove_dir_all(root).unwrap();
    }
}
