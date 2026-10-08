//! A single completed result shared between windows, never written to disk.
use serde::Serialize;
use serde_json::Value;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultView { id: String, epoch: String, run: Value, persisted: bool, acknowledged: bool }
#[derive(Clone, Default, Serialize)]
pub struct Snapshot { revision: u64, result: Option<ResultView> }
impl Snapshot {
    fn publish(&mut self, epoch: String, run: Value, persisted: bool) {
        self.revision += 1;
        self.result = Some(ResultView { id: uuid::Uuid::new_v4().to_string(), epoch, run, persisted, acknowledged: false });
    }
    fn acknowledge(&mut self, id: &str, epoch: &str) -> Result<(), String> {
        let result = self.result.as_mut().filter(|result| result.id == id && result.epoch == epoch).ok_or("Result expired")?;
        result.acknowledged = true; self.revision += 1; Ok(())
    }
    fn dismiss(&mut self, id: &str, epoch: &str) -> bool {
        if self.result.as_ref().is_some_and(|result| result.id == id && result.epoch == epoch) { self.reset(); true } else { false }
    }
    fn reset(&mut self) { self.result = None; self.revision += 1; }
}
#[derive(Default)]
pub struct TransientResults(Mutex<Snapshot>);
impl TransientResults {
    pub fn clear(&self, app: &AppHandle) {
        if let Ok(mut snapshot) = self.0.lock() { snapshot.reset(); let _ = app.emit("latch-transient-result", &*snapshot); }
    }
}
fn authorize(window: &WebviewWindow, label: &str) -> Result<(), String> {
    if window.label() == label { Ok(()) } else { Err("This window cannot manage this result".into()) }
}
fn sanitize(run: Value) -> Result<Value, String> {
    let object = run.as_object().ok_or("Invalid result")?;
    if object.get("id").and_then(Value::as_str).is_none() || object.get("finalResponse").and_then(Value::as_str).is_none() { return Err("A completed result is required".into()); }
    let fields = ["id", "agentId", "agentName", "agentIcon", "sourceApplication", "sourceIcon", "activity", "model", "sandbox", "startedAt", "duration", "threadId", "workspacePath", "finalResponse"];
    let mut result = serde_json::Map::new();
    for field in fields { if let Some(value) = object.get(field) { result.insert(field.into(), value.clone()); } }
    result.insert("status".into(), Value::String("completed".into()));
    Ok(Value::Object(result))
}
#[tauri::command]
pub fn publish_transient_result(window: WebviewWindow, app: AppHandle, state: State<TransientResults>, epoch: String, run: Value) -> Result<Snapshot, String> {
    authorize(&window, "context-bar")?;
    let run = sanitize(run)?;
    let mut snapshot = state.0.lock().map_err(|_| "Result unavailable")?;
    let persisted = app.state::<crate::persistence::Persistence>().contains_result(&epoch, run["id"].as_str().unwrap_or_default())?;
    snapshot.publish(epoch, run, persisted);
    app.emit("latch-transient-result", &*snapshot).map_err(|e| e.to_string())?;
    Ok(snapshot.clone())
}
#[tauri::command]
pub fn transient_result(window: WebviewWindow, state: State<TransientResults>) -> Result<Snapshot, String> {
    authorize(&window, "studio")?;
    state.0.lock().map(|value| value.clone()).map_err(|_| "Result unavailable".into())
}
#[tauri::command]
pub fn acknowledge_transient_result(window: WebviewWindow, app: AppHandle, state: State<TransientResults>, id: String, epoch: String) -> Result<(), String> {
    authorize(&window, "studio")?;
    let mut snapshot = state.0.lock().map_err(|_| "Result unavailable")?;
    app.state::<crate::persistence::Persistence>().history_for_epoch(&epoch)?;
    snapshot.acknowledge(&id, &epoch)?;
    app.emit("latch-transient-result", &*snapshot).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn dismiss_transient_result(window: WebviewWindow, app: AppHandle, state: State<TransientResults>, id: String, epoch: String) -> Result<(), String> {
    authorize(&window, "studio")?;
    let mut snapshot = state.0.lock().map_err(|_| "Result unavailable")?;
    app.state::<crate::persistence::Persistence>().history_for_epoch(&epoch)?;
    if snapshot.dismiss(&id, &epoch) {
        app.emit("latch-transient-result", &*snapshot).map_err(|e| e.to_string())?;
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn original_context_never_enters_the_handoff() {
        let result = sanitize(serde_json::json!({"id":"run", "finalResponse":"answer", "conversation":[{"id":"selected-text","text":"secret"}], "selectedText":"secret", "status":"running"})).unwrap();
        assert!(result.get("conversation").is_none()); assert!(result.get("selectedText").is_none()); assert_eq!(result["status"], "completed");
        assert!(sanitize(Value::Null).is_err());
    }
    #[test]
    fn snapshots_survive_acknowledgement_but_not_dismissal_or_reset() {
        let mut snapshot = Snapshot::default();
        let run = sanitize(serde_json::json!({"id":"history-id", "finalResponse":"answer"})).unwrap();
        snapshot.publish("epoch".into(), run.clone(), false);
        let id = snapshot.result.as_ref().unwrap().id.clone();
        assert!(snapshot.acknowledge(&id, "old-epoch").is_err());
        snapshot.acknowledge(&id, "epoch").unwrap();
        assert_eq!(snapshot.result.as_ref().unwrap().run["id"], "history-id");
        assert!(!snapshot.result.as_ref().unwrap().persisted);
        assert!(!snapshot.dismiss("other", "epoch"));
        let mounted = snapshot.clone(); assert!(mounted.result.unwrap().acknowledged);
        snapshot.publish("epoch".into(), run, true);
        assert!(snapshot.acknowledge(&id, "epoch").is_err());
        let newer = snapshot.result.as_ref().unwrap().id.clone();
        assert!(snapshot.dismiss(&newer, "epoch")); assert!(snapshot.result.is_none());
        snapshot.reset(); assert!(snapshot.acknowledge(&newer, "epoch").is_err());
    }

}
