use serde::Serialize;
use serde_json::Value;
use std::sync::Arc;
use tauri::Emitter;
type Sink = dyn Fn(&str, Value) -> Result<(), String> + Send + Sync;
#[derive(Clone)]
pub(crate) struct RuntimeEvents(Arc<Sink>);
impl RuntimeEvents {
    pub fn new(sink: impl Fn(&str, Value) -> Result<(), String> + Send + Sync + 'static) -> Self {
        Self(Arc::new(sink))
    }
    pub fn tauri(app: tauri::AppHandle) -> Self {
        Self::new(move |name, value| app.emit(name, value).map_err(|error| error.to_string()))
    }
    pub fn emit(&self, name: &str, value: impl Serialize) -> Result<(), String> {
        (self.0)(
            name,
            serde_json::to_value(value).map_err(|error| error.to_string())?,
        )
    }
}
