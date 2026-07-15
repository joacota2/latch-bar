use serde::{Deserialize, Serialize};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, LogicalPosition, Manager, State};

#[cfg(target_os = "macos")]
mod macos;
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod unsupported;
#[cfg(target_os = "windows")]
mod windows;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSelection {
    pub text: String,
    pub application: String,
    pub window_title: Option<String>,
    pub process_id: i32,
    pub bounds: SelectionBounds,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformStatus {
    pub platform: &'static str,
    pub supported: bool,
    pub accessibility_trusted: bool,
    pub permission_required: Option<&'static str>,
    pub implementation: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplacementResult {
    pub method: &'static str,
}

pub trait PlatformAdapter: Send + Sync {
    fn status(&self, prompt: bool) -> PlatformStatus;
    fn capture_selection(&self) -> Result<Option<NativeSelection>, String>;
    fn replace_selection(&self, text: &str) -> Result<ReplacementResult, String>;
    fn copy_text(&self, text: &str) -> Result<(), String>;
}

#[derive(Default)]
pub struct PlatformState {
    adapter: Arc<Adapter>,
    monitor_started: AtomicBool,
    overlay_pinned: Arc<AtomicBool>,
    monitor_config: Arc<Mutex<MonitorConfig>>,
}

#[cfg(target_os = "macos")]
type Adapter = macos::MacOsAdapter;
#[cfg(target_os = "windows")]
type Adapter = windows::WindowsAdapter;
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
type Adapter = unsupported::UnsupportedAdapter;

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorConfig {
    enabled: bool,
    delay_ms: u64,
    minimum_characters: usize,
    excluded_applications: Vec<String>,
}

#[tauri::command]
pub fn platform_status(state: State<PlatformState>, prompt: bool) -> PlatformStatus {
    state.adapter.status(prompt)
}

#[tauri::command]
pub fn start_selection_monitor(
    app: AppHandle,
    state: State<PlatformState>,
    config: MonitorConfig,
) -> Result<(), String> {
    let enabled = config.enabled;
    *state
        .monitor_config
        .lock()
        .map_err(|_| "Selection monitor settings are unavailable")? = config;
    if !enabled {
        state.overlay_pinned.store(false, Ordering::SeqCst);
        if let Some(window) = app.get_webview_window("context-bar") {
            let _ = window.hide();
        }
    }
    if state.monitor_started.swap(true, Ordering::SeqCst) {
        return Ok(());
    }

    let adapter = state.adapter.clone();
    let pinned = state.overlay_pinned.clone();
    let monitor_config = state.monitor_config.clone();
    std::thread::spawn(move || {
        let mut candidate: Option<(i32, String, Instant)> = None;
        let mut last_emitted: Option<(i32, String)> = None;
        loop {
            std::thread::sleep(Duration::from_millis(120));
            let config = match monitor_config.lock() {
                Ok(value) => value.clone(),
                Err(_) => continue,
            };
            if !config.enabled {
                candidate = None;
                last_emitted = None;
                if let Some(window) = app.get_webview_window("context-bar") {
                    let _ = window.hide();
                }
                continue;
            }
            if pinned.load(Ordering::SeqCst) {
                continue;
            }

            let selection = adapter
                .capture_selection()
                .ok()
                .flatten()
                .filter(|selection| {
                    selection.text.chars().count() >= config.minimum_characters
                        && !config
                            .excluded_applications
                            .iter()
                            .any(|excluded| selection.application.eq_ignore_ascii_case(excluded))
                });

            let Some(selection) = selection else {
                candidate = None;
                last_emitted = None;
                if let Some(window) = app.get_webview_window("context-bar") {
                    let _ = window.hide();
                }
                continue;
            };

            let key = (selection.process_id, selection.text.clone());
            if candidate.as_ref().map(|item| (&item.0, &item.1)) != Some((&key.0, &key.1)) {
                candidate = Some((key.0, key.1.clone(), Instant::now()));
                continue;
            }
            if candidate
                .as_ref()
                .is_some_and(|item| item.2.elapsed() < Duration::from_millis(config.delay_ms))
                || last_emitted.as_ref() == Some(&key)
            {
                continue;
            }

            if let Some(window) = app.get_webview_window("context-bar") {
                let mut x = (selection.bounds.x + selection.bounds.width / 2.0 - 390.0).max(8.0);
                let mut y = (selection.bounds.y + selection.bounds.height + 10.0).max(8.0);
                if let Ok(monitors) = window.available_monitors() {
                    if let Some(monitor) = monitors.into_iter().find(|monitor| {
                        let scale = monitor.scale_factor();
                        let left = monitor.position().x as f64 / scale;
                        let top = monitor.position().y as f64 / scale;
                        let right = left + monitor.size().width as f64 / scale;
                        let bottom = top + monitor.size().height as f64 / scale;
                        selection.bounds.x >= left
                            && selection.bounds.x <= right
                            && selection.bounds.y >= top
                            && selection.bounds.y <= bottom
                    }) {
                        let scale = monitor.scale_factor();
                        let left = monitor.position().x as f64 / scale;
                        let top = monitor.position().y as f64 / scale;
                        let right = left + monitor.size().width as f64 / scale;
                        let bottom = top + monitor.size().height as f64 / scale;
                        x = x.clamp(left + 8.0, (right - 788.0).max(left + 8.0));
                        if y + 76.0 > bottom - 8.0 {
                            y = (selection.bounds.y - 86.0).max(top + 8.0);
                        } else {
                            y = y.max(top + 8.0);
                        }
                    }
                }
                let _ = window.set_position(LogicalPosition::new(x, y));
                let _ = window.emit("native-selection", &selection);
                let _ = window.show();
            }
            last_emitted = Some(key);
        }
    });
    Ok(())
}

#[tauri::command]
pub fn set_overlay_pinned(state: State<PlatformState>, pinned: bool) {
    state.overlay_pinned.store(pinned, Ordering::SeqCst);
}

#[tauri::command]
pub fn hide_context_bar(app: AppHandle, state: State<PlatformState>) -> Result<(), String> {
    state.overlay_pinned.store(false, Ordering::SeqCst);
    app.get_webview_window("context-bar")
        .ok_or("Context Bar window is unavailable")?
        .hide()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn replace_selection(
    state: State<PlatformState>,
    text: String,
) -> Result<ReplacementResult, String> {
    let result = state.adapter.replace_selection(&text)?;
    state.overlay_pinned.store(false, Ordering::SeqCst);
    Ok(result)
}

#[tauri::command]
pub fn copy_text(state: State<PlatformState>, text: String) -> Result<(), String> {
    state.adapter.copy_text(&text)
}

#[tauri::command]
pub fn open_studio(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("studio")
        .ok_or("Studio window is unavailable")?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}
