use crate::runtime::RuntimeManager;
use serde::Serialize;
use std::{
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_updater::Update;

const EVENT: &str = "latch-update-state";
const INITIAL_DELAY: Duration = Duration::from_secs(30);
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Unavailable,
    Idle,
    Checking,
    UpToDate,
    Available,
    Downloading,
    Installing,
    Restarting,
    Error,
}

impl Phase {
    fn busy(&self) -> bool {
        matches!(
            self,
            Self::Checking | Self::Downloading | Self::Installing | Self::Restarting
        )
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    revision: u64,
    enabled: bool,
    current_version: String,
    phase: Phase,
    available_version: Option<String>,
    notes: Option<String>,
    last_checked_at: Option<u64>,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    error: Option<String>,
}

struct Inner {
    state: UpdateState,
    update: Option<Update>,
}

pub struct UpdateManager(Mutex<Inner>);

impl Default for UpdateManager {
    fn default() -> Self {
        let enabled = cfg!(all(target_os = "macos", not(debug_assertions)));
        Self(Mutex::new(Inner {
            state: UpdateState {
                revision: 0,
                enabled,
                current_version: env!("CARGO_PKG_VERSION").into(),
                phase: if enabled {
                    Phase::Idle
                } else {
                    Phase::Unavailable
                },
                available_version: None,
                notes: None,
                last_checked_at: None,
                downloaded_bytes: 0,
                total_bytes: None,
                error: None,
            },
            update: None,
        }))
    }
}

impl UpdateManager {
    fn snapshot(&self) -> Result<UpdateState, String> {
        Ok(self
            .0
            .lock()
            .map_err(|_| "Update state unavailable")?
            .state
            .clone())
    }

    fn change(&self, app: &AppHandle, change: impl FnOnce(&mut Inner)) {
        if let Ok(mut inner) = self.0.lock() {
            change(&mut inner);
            publish(app, &mut inner.state);
        }
    }
}

fn publish(app: &AppHandle, state: &mut UpdateState) {
    state.revision += 1;
    let _ = app.emit(EVENT, &*state);
}

fn authorize(label: &str) -> Result<(), String> {
    if label == "studio" {
        Ok(())
    } else {
        Err("Updates can only be managed from Studio.".into())
    }
}

#[tauri::command]
pub fn update_state(
    window: WebviewWindow,
    manager: State<UpdateManager>,
) -> Result<UpdateState, String> {
    authorize(window.label())?;
    manager.snapshot()
}

#[tauri::command]
pub fn update_editor_state(
    window: WebviewWindow,
    runtime: State<RuntimeManager>,
    open: bool,
) -> Result<(), String> {
    authorize(window.label())?;
    runtime.1.set_editor_open(open)
}

#[tauri::command]
pub async fn check_for_updates(
    window: WebviewWindow,
    app: AppHandle,
) -> Result<UpdateState, String> {
    authorize(window.label())?;
    check(&app).await
}

async fn check(app: &AppHandle) -> Result<UpdateState, String> {
    let manager = app.state::<UpdateManager>();
    {
        let mut inner = manager.0.lock().map_err(|_| "Update state unavailable")?;
        if !inner.state.enabled || inner.state.phase.busy() {
            return Ok(inner.state.clone());
        }
        inner.update = None;
        inner.state.available_version = None;
        inner.state.notes = None;
        inner.state.error = None;
        inner.state.phase = Phase::Checking;
        publish(app, &mut inner.state);
    }
    let result = async {
        tokio::time::timeout(Duration::from_secs(65), crate::private_release::check(app))
            .await
            .map_err(|_| "The update check timed out. Please try again.".to_string())?
    }
    .await;
    manager.change(app, |inner| {
        inner.state.last_checked_at = Some(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
        );
        match result {
            Ok(update) => {
                inner.state.phase = if update.is_some() {
                    Phase::Available
                } else {
                    Phase::UpToDate
                };
                inner.state.available_version = update.as_ref().map(|item| item.version.clone());
                inner.state.notes = update.as_ref().and_then(|item| item.body.clone());
                inner.update = update;
            }
            Err(error) => {
                inner.state.phase = Phase::Error;
                inner.state.error = Some(format!("Could not check for updates: {error}"));
            }
        }
    });
    manager.snapshot()
}

#[tauri::command]
pub async fn install_update(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    authorize(window.label())?;
    let manager = app.state::<UpdateManager>();
    let runtime = app.state::<RuntimeManager>();
    let (mut update, permit) = {
        let mut inner = manager.0.lock().map_err(|_| "Update state unavailable")?;
        if !inner.state.enabled {
            return Err("Updates are only available in the macOS release app.".into());
        }
        if inner.state.phase.busy() {
            return Err("An update operation is already in progress.".into());
        }
        let update = inner
            .update
            .clone()
            .ok_or("Check for a new version before updating.")?;
        // Atomic with all runtime starts and continuations, regardless of window.
        let permit = runtime.1.install()?;
        inner.state.phase = Phase::Downloading;
        inner.state.error = None;
        inner.state.downloaded_bytes = 0;
        inner.state.total_bytes = None;
        publish(&app, &mut inner.state);
        (update, permit)
    };
    update.timeout = Some(Duration::from_secs(5 * 60));
    let result = async {
        let mut downloaded = 0_u64;
        let mut last_progress = Instant::now();
        let bytes = update
            .download(
                |chunk, total| {
                    downloaded += chunk as u64;
                    if last_progress.elapsed() >= Duration::from_millis(100) {
                        manager.change(&app, |inner| {
                            inner.state.downloaded_bytes = downloaded;
                            inner.state.total_bytes = total.filter(|size| *size > 0);
                        });
                        last_progress = Instant::now();
                    }
                },
                || {},
            )
            .await
            .map_err(|error| format!("Could not download or verify the update: {error}"))?;
        manager.change(&app, |inner| {
            inner.state.downloaded_bytes = bytes.len() as u64;
            inner.state.phase = Phase::Installing;
        });
        tauri::async_runtime::spawn_blocking(move || update.install(bytes))
            .await
            .map_err(|error| error.to_string())?
            .map_err(|error| format!("Could not install the update: {error}"))?;
        Ok::<(), String>(())
    }
    .await;
    if let Err(error) = result {
        drop(permit);
        manager.change(&app, |inner| {
            inner.state.phase = Phase::Error;
            inner.state.error = Some(error.clone());
        });
        return Err(error);
    }
    manager.change(&app, |inner| inner.state.phase = Phase::Restarting);
    runtime.shutdown();
    // Keep the installation lease until the process exits, including the restart.
    app.restart();
}

pub fn schedule(app: AppHandle) {
    app.state::<UpdateManager>().change(&app, |inner| {
        inner.state.current_version = app.package_info().version.to_string();
    });
    if !cfg!(all(target_os = "macos", not(debug_assertions))) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(INITIAL_DELAY).await;
        loop {
            let _ = check(&app).await;
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_studio_can_manage_updates() {
        assert!(authorize("studio").is_ok());
        assert!(authorize("context-bar").is_err());
        assert!(authorize("other").is_err());
    }

    #[test]
    fn development_builds_are_disabled() {
        let state = UpdateManager::default().snapshot().unwrap();
        assert!(!state.enabled);
        assert_eq!(state.phase, Phase::Unavailable);
    }

    #[test]
    fn all_in_flight_operations_are_exclusive() {
        for phase in [
            Phase::Checking,
            Phase::Downloading,
            Phase::Installing,
            Phase::Restarting,
        ] {
            assert!(phase.busy());
        }
        for phase in [Phase::Idle, Phase::Error, Phase::Available, Phase::UpToDate] {
            assert!(!phase.busy());
        }
    }
}
