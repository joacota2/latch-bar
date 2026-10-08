//! Bounded version probes, shared by status, catalog discovery and launches.
use std::{
    fs,
    io::Read,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{mpsc, Mutex, OnceLock},
    time::{Duration, Instant, SystemTime},
};
#[derive(Clone, Debug)]
pub struct Executable {
    pub path: PathBuf,
    pub version: String,
}
struct Cached {
    executable: Result<Executable, String>,
    modified: Option<SystemTime>,
    size: u64,
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
pub fn probe(mut command: Command, deadline: Instant) -> Option<String> {
    if Instant::now() >= deadline {
        return None;
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
        .ok()?;
    let stdout = child.stdout.take()?;
    let (send, receive) = mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.take(8192).read_to_end(&mut bytes);
        let _ = send.send(bytes);
    });
    let expires = deadline.min(Instant::now() + Duration::from_secs(2));
    let success = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Err(_) => break false,
            _ => {}
        }
        if Instant::now() >= expires {
            break false;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    terminate(&mut child);
    if !success {
        return None;
    }
    let output = receive.recv_timeout(Duration::from_millis(100)).ok()?;
    let version = String::from_utf8_lossy(&output).trim().to_string();
    (!crate::scanner::parse_codex_version(version.as_bytes()).is_empty()).then_some(version)
}
pub fn newest(candidates: Vec<PathBuf>, directories: &[PathBuf]) -> Option<Executable> {
    let deadline = Instant::now() + Duration::from_secs(10);
    let pending = Mutex::new(candidates.into_iter());
    let found = Mutex::new(Vec::new());
    std::thread::scope(|scope| {
        for _ in 0..4 {
            scope.spawn(|| loop {
                if Instant::now() >= deadline {
                    break;
                }
                let Some(path) = pending
                    .lock()
                    .ok()
                    .and_then(|mut candidates| candidates.next())
                else {
                    break;
                };
                if let Some(version) = probe(
                    crate::scanner::command_for_executable(&path, directories),
                    deadline,
                ) {
                    found.lock().unwrap().push(Executable { path, version });
                }
            });
        }
    });
    found.into_inner().ok()?.into_iter().max_by_key(|item| {
        (
            crate::scanner::parse_codex_version(item.version.as_bytes()),
            item.path.clone(),
        )
    })
}
pub fn resolve(
    candidates: Vec<PathBuf>,
    directories: &[PathBuf],
    configured: Option<PathBuf>,
    force: bool,
) -> Result<Executable, String> {
    let requested_at = Instant::now();
    let context = format!("{directories:?}:{configured:?}");
    let mut guard = CACHE
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "Runtime discovery unavailable")?;
    if let Some(cache) = guard.as_ref() {
        if cache.context == context {
            match &cache.executable {
                Err(error) if cache.at >= requested_at => return Err(error.clone()),
                Ok(executable) => {
                    let metadata = fs::metadata(&executable.path).ok();
                    if cache.at.elapsed() < Duration::from_secs(300)
                        && (!force || cache.at >= requested_at)
                        && metadata.as_ref().is_some_and(|data| {
                            data.modified().ok() == cache.modified && data.len() == cache.size
                        })
                    {
                        return Ok(executable.clone());
                    }
                }
                _ => {}
            }
        }
    }
    let result = (|| {
        let executable = if let Some(path) = configured {
            let version = probe(crate::scanner::command_for_executable(&path, directories), Instant::now() + Duration::from_secs(2)).ok_or_else(|| format!("CODEX_BIN {} is unavailable or did not return a version within two seconds. Fix or remove the override.", path.display()))?;
            Executable { path, version }
        } else {
            newest(candidates, directories)
                .ok_or("No working Codex installation responded. Install Codex or check again.")?
        };
        let metadata = fs::metadata(&executable.path).map_err(|error| error.to_string())?;
        Ok((executable, metadata))
    })();
    let (executable, modified, size) = match result {
        Ok((executable, metadata)) => (Ok(executable), metadata.modified().ok(), metadata.len()),
        Err(error) => (Err(error), None, 0),
    };
    *guard = Some(Cached {
        executable: executable.clone(),
        modified,
        size,
        at: Instant::now(),
        context,
    });
    executable
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
        assert_eq!(found.path, root.join("good"));
        assert!(started.elapsed() < Duration::from_secs(4));
        assert!(resolve(
            vec![root.join("good")],
            &[],
            Some(root.join("missing")),
            true
        )
        .unwrap_err()
        .contains("CODEX_BIN"));
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
        let discover = || resolve(vec![path.clone()], &[], None, false).unwrap();
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
        resolve(vec![path.clone()], &[], None, true).unwrap();
        invalidate();
        discover();
        fs::write(&path, format!("{script}# changed executable\n")).unwrap();
        discover();
        assert_eq!(fs::read_to_string(&count).unwrap().lines().count(), 5);
        invalidate();
        fs::remove_dir_all(root).unwrap();
    }
}
