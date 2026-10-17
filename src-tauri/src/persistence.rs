//! One authoritative snapshot for all webviews. CAS prevents lost updates;
//! reset epochs reject callbacks belonging to a cleared session.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    sync::Mutex,
};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    revision: u64,
    epoch: String,
    state: Value,
}
#[derive(Serialize)]
pub struct WriteResult {
    accepted: bool,
    snapshot: Snapshot,
}
#[derive(Default)]
pub struct Persistence(Mutex<Option<Snapshot>>);

fn authorize(label: &str) -> Result<(), String> {
    if matches!(label, "studio" | "context-bar") {
        Ok(())
    } else {
        Err("This window cannot access Latch state".into())
    }
}
fn persist(path: &Path, snapshot: &Snapshot) -> Result<(), String> {
    fs::create_dir_all(path.parent().ok_or("Invalid state path")?).map_err(|e| e.to_string())?;
    let temporary = path.with_extension("tmp");
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(|e| e.to_string())?;
        file.write_all(&serde_json::to_vec(snapshot).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        fs::rename(&temporary, path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}
fn reconcile(state: &mut Value) {
    if let Some(runs) = state.get_mut("runs").and_then(Value::as_array_mut) {
        for run in runs {
            if matches!(
                run.get("status").and_then(Value::as_str),
                Some("running" | "approval")
            ) {
                run["status"] = "cancelled".into();
                run["activity"] = "Interrupted when Latch Bar closed".into();
            }
        }
    }
}
impl Persistence {
    pub fn history_for_epoch(&self, epoch: &str) -> Result<bool, String> {
        let guard = self.0.lock().map_err(|_| "Local state unavailable")?;
        let current = guard
            .as_ref()
            .filter(|current| current.epoch == epoch)
            .ok_or("This result belongs to a cleared session")?;
        Ok(current
            .state
            .pointer("/settings/storeHistory")
            .and_then(Value::as_bool)
            .unwrap_or(true))
    }

    pub fn contains_result(&self, epoch: &str, id: &str) -> Result<bool, String> {
        let guard = self.0.lock().map_err(|_| "Local state unavailable")?;
        let current = guard
            .as_ref()
            .filter(|current| current.epoch == epoch)
            .ok_or("This result belongs to a cleared session")?;
        Ok(current
            .state
            .get("runs")
            .and_then(Value::as_array)
            .is_some_and(|runs| {
                runs.iter()
                    .any(|run| run["id"] == id && run["status"] == "completed")
            }))
    }

    fn read(&self, path: &Path, initial: Value) -> Result<Snapshot, String> {
        let mut guard = self.0.lock().map_err(|_| "Local state unavailable")?;
        if let Some(snapshot) = guard.as_ref() {
            return Ok(snapshot.clone());
        }
        let mut snapshot = if path.exists() {
            serde_json::from_slice::<Snapshot>(&fs::read(path).map_err(|e| e.to_string())?)
                .map_err(|_| "Saved latch-state.json is unreadable. Restore or repair it, then restart Latch Bar.".to_string())?
        } else {
            Snapshot {
                revision: 0,
                epoch: Uuid::new_v4().to_string(),
                state: initial,
            }
        };
        // This runs once per native process, never on ordinary window sync.
        reconcile(&mut snapshot.state);
        snapshot.revision += 1;
        persist(path, &snapshot)?;
        *guard = Some(snapshot.clone());
        Ok(snapshot)
    }
    fn write(
        &self,
        path: &Path,
        revision: u64,
        epoch: &str,
        state: Value,
        reset: bool,
    ) -> Result<WriteResult, String> {
        let mut guard = self.0.lock().map_err(|_| "Local state unavailable")?;
        let current = guard.as_ref().ok_or("Load local state before saving")?;
        if current.revision != revision || current.epoch != epoch {
            return Ok(WriteResult {
                accepted: false,
                snapshot: current.clone(),
            });
        }
        let next = Snapshot {
            revision: revision + 1,
            epoch: if reset {
                Uuid::new_v4().to_string()
            } else {
                epoch.to_string()
            },
            state,
        };
        persist(path, &next)?; // Publish only after durable write succeeds.
        *guard = Some(next.clone());
        Ok(WriteResult {
            accepted: true,
            snapshot: next,
        })
    }
}
#[tauri::command]
pub fn read_latch_state(
    window: WebviewWindow,
    app: AppHandle,
    store: State<Persistence>,
    initial: Value,
) -> Result<Snapshot, String> {
    authorize(window.label())?;
    store.read(
        &app.path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("latch-state.json"),
        initial,
    )
}
#[tauri::command]
pub fn write_latch_state(
    window: WebviewWindow,
    app: AppHandle,
    store: State<Persistence>,
    revision: u64,
    epoch: String,
    state: Value,
    reset: bool,
) -> Result<WriteResult, String> {
    authorize(window.label())?;
    if reset && window.label() != "studio" {
        return Err("Clear data is only available in Studio".into());
    }
    let result = store.write(
        &app.path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("latch-state.json"),
        revision,
        &epoch,
        state,
        reset,
    )?;
    if result.accepted {
        if reset {
            app.state::<crate::transient::TransientResults>()
                .clear(&app);
        }
        if reset
            || result
                .snapshot
                .state
                .pointer("/settings/contextBarEnabled")
                .and_then(Value::as_bool)
                == Some(false)
        {
            app.state::<crate::runtime::RuntimeManager>().shutdown();
        }
        let _ = app.emit("latch-state-changed", ());
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn path() -> std::path::PathBuf {
        std::env::temp_dir()
            .join(format!("latch-persistence-{}", Uuid::new_v4()))
            .join("state.json")
    }
    #[test]
    fn concurrent_writers_retry_without_lost_fields_and_reset_rejects_old_work() {
        let path = path();
        let store = std::sync::Arc::new(Persistence::default());
        let initial = store.read(&path, json!({"settings":{},"runs":[]})).unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let handles: Vec<_> = ["a", "b"]
            .into_iter()
            .map(|key| {
                let (store, path, barrier, mut snapshot) = (
                    store.clone(),
                    path.clone(),
                    barrier.clone(),
                    initial.clone(),
                );
                std::thread::spawn(move || {
                    barrier.wait();
                    loop {
                        let mut next = snapshot.state.clone();
                        next["settings"][key] = true.into();
                        let result = store
                            .write(&path, snapshot.revision, &snapshot.epoch, next, false)
                            .unwrap();
                        if result.accepted {
                            break;
                        }
                        snapshot = result.snapshot;
                    }
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }
        let current = store.read(&path, Value::Null).unwrap();
        assert_eq!(current.state["settings"], json!({"a":true,"b":true}));
        let reset = store
            .write(
                &path,
                current.revision,
                &current.epoch,
                json!({"runs":[]}),
                true,
            )
            .unwrap();
        assert!(reset.accepted);
        assert!(
            !store
                .write(
                    &path,
                    reset.snapshot.revision,
                    &current.epoch,
                    current.state,
                    false
                )
                .unwrap()
                .accepted
        );
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
    #[test]
    fn startup_reconciles_once_and_failed_write_preserves_last_snapshot() {
        let path = path();
        let store = Persistence::default();
        let first = store
            .read(
                &path,
                json!({"runs":[{"id":"a","status":"approval"},{"id":"b","status":"completed"}]}),
            )
            .unwrap();
        assert_eq!(first.state["runs"][0]["status"], "cancelled");
        let active = store
            .write(
                &path,
                first.revision,
                &first.epoch,
                json!({"runs":[{"id":"live","status":"running"}]}),
                false,
            )
            .unwrap()
            .snapshot;
        assert_eq!(
            store.read(&path, Value::Null).unwrap().state["runs"][0]["status"],
            "running"
        );
        let invalid = path.join("not-a-directory");
        assert!(store
            .write(&invalid, active.revision, &active.epoch, json!({}), false)
            .is_err());
        assert_eq!(
            store.read(&path, Value::Null).unwrap().revision,
            active.revision
        );
        let restarted = Persistence::default().read(&path, Value::Null).unwrap();
        assert_eq!(restarted.state["runs"][0]["status"], "cancelled");
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
}
