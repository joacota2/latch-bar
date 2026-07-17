use serde::{Deserialize, Serialize};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, State};

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
    pub monitor_running: bool,
    pub context_bar_ready: bool,
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
    pointer_monitor_started: AtomicBool,
    context_bar_ready: Arc<AtomicBool>,
    overlay_pinned: Arc<AtomicBool>,
    dismiss_current_selection: Arc<AtomicBool>,
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

fn selection_is_allowed(selection: &NativeSelection, config: &MonitorConfig) -> bool {
    selection.text.chars().count() >= config.minimum_characters
        && !config
            .excluded_applications
            .iter()
            .any(|excluded| selection.application.eq_ignore_ascii_case(excluded))
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct SelectionKey {
    process_id: i32,
    text: String,
    x: i64,
    y: i64,
    width: i64,
    height: i64,
}

fn selection_key(selection: &NativeSelection) -> SelectionKey {
    // Accessibility bounds can move by a fraction of a point between reads. Half-point
    // quantization keeps one selection stable while still distinguishing the same text
    // selected somewhere else in the same application.
    let coordinate = |value: f64| (value * 2.0).round() as i64;
    SelectionKey {
        process_id: selection.process_id,
        text: selection.text.clone(),
        x: coordinate(selection.bounds.x),
        y: coordinate(selection.bounds.y),
        width: coordinate(selection.bounds.width),
        height: coordinate(selection.bounds.height),
    }
}

#[tauri::command]
pub fn platform_status(state: State<PlatformState>, prompt: bool) -> PlatformStatus {
    let mut status = state.adapter.status(prompt);
    status.monitor_running = state.monitor_started.load(Ordering::SeqCst);
    status.context_bar_ready = state.context_bar_ready.load(Ordering::SeqCst);
    status
}

#[tauri::command]
pub fn repair_accessibility_permission(
    app: AppHandle,
    state: State<PlatformState>,
) -> Result<PlatformStatus, String> {
    #[cfg(target_os = "macos")]
    {
        let identifier = &app.config().identifier;
        let result = std::process::Command::new("/usr/bin/tccutil")
            .args(["reset", "Accessibility", identifier])
            .status()
            .map_err(|error| format!("Could not reset Accessibility permission: {error}"))?;
        if !result.success() {
            return Err(format!(
                "Could not reset Accessibility permission (tccutil exited with {result})"
            ));
        }
        return Ok(state.adapter.status(true));
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(state.adapter.status(false))
    }
}

#[tauri::command]
pub fn context_bar_ready(app: AppHandle, state: State<PlatformState>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::NSWindow;
        let window = app
            .get_webview_window("context-bar")
            .ok_or("Context Bar window is unavailable")?;
        let pointer = window.ns_window().map_err(|error| error.to_string())?;
        let native_window = unsafe {
            (pointer as *const NSWindow)
                .as_ref()
                .ok_or("Context Bar native window is unavailable")?
        };
        // Non-activating NSWindows do not opt into mouse-moved delivery by default.
        // WKWebView needs these events for :hover and pointer-enter transitions. Explicitly
        // enable hit testing too so clicks cannot fall through to the Studio window below.
        native_window.setIgnoresMouseEvents(false);
        native_window.setAcceptsMouseMovedEvents(true);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = &app;
    state.context_bar_ready.store(true, Ordering::SeqCst);
    if !state.pointer_monitor_started.swap(true, Ordering::SeqCst) {
        let pointer_app = app.clone();
        std::thread::spawn(move || {
            let mut last_position: Option<(i32, i32)> = None;
            loop {
                std::thread::sleep(Duration::from_millis(35));
                let Some(window) = pointer_app.get_webview_window("context-bar") else {
                    continue;
                };
                if window.is_visible().ok() != Some(true) {
                    last_position = None;
                    continue;
                }
                let Ok(cursor) = window.cursor_position() else {
                    continue;
                };
                let Ok(origin) = window.outer_position() else {
                    continue;
                };
                let Ok(scale) = window.scale_factor() else {
                    continue;
                };
                let Ok(size) = window.outer_size() else {
                    continue;
                };
                let x = ((cursor.x - origin.x as f64) / scale).round() as i32;
                let y = ((cursor.y - origin.y as f64) / scale).round() as i32;
                let inside = x >= 0
                    && y >= 0
                    && (x as f64) < size.width as f64 / scale
                    && (y as f64) < size.height as f64 / scale;
                let position = inside.then_some((x, y));
                if position != last_position {
                    let _ = window.emit(
                        "context-pointer-position",
                        serde_json::json!({"x":x,"y":y,"inside":inside}),
                    );
                    last_position = position;
                }
            }
        });
    }
    Ok(())
}

#[tauri::command]
pub fn focus_selection_application(process_id: i32) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};
        let application = NSRunningApplication::runningApplicationWithProcessIdentifier(process_id)
            .ok_or("The source application is no longer running")?;
        if !application.activateWithOptions(NSApplicationActivationOptions::empty()) {
            return Err("Could not reactivate the source application".into());
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = process_id;
    Ok(())
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
    let context_bar_ready = state.context_bar_ready.clone();
    let pinned = state.overlay_pinned.clone();
    let dismiss_current_selection = state.dismiss_current_selection.clone();
    let monitor_config = state.monitor_config.clone();
    std::thread::spawn(move || {
        let mut candidate: Option<(SelectionKey, Instant)> = None;
        let mut last_emitted: Option<SelectionKey> = None;
        let mut dismissed: Option<SelectionKey> = None;
        loop {
            std::thread::sleep(Duration::from_millis(120));
            let config = match monitor_config.lock() {
                Ok(value) => value.clone(),
                Err(_) => continue,
            };
            if !config.enabled {
                candidate = None;
                last_emitted = None;
                dismissed = None;
                if let Some(window) = app.get_webview_window("context-bar") {
                    let _ = window.hide();
                }
                continue;
            }
            if !context_bar_ready.load(Ordering::SeqCst) {
                continue;
            }
            if pinned.load(Ordering::SeqCst) {
                continue;
            }

            if dismiss_current_selection.swap(false, Ordering::SeqCst) {
                dismissed = last_emitted
                    .take()
                    .or_else(|| candidate.as_ref().map(|item| item.0.clone()));
                candidate = None;
            }

            let selection = match adapter.capture_selection() {
                Ok(selection) => selection,
                Err(error) => {
                    eprintln!("Native selection capture failed: {error}");
                    None
                }
            }
            .filter(|selection| selection_is_allowed(selection, &config));

            let Some(selection) = selection else {
                candidate = None;
                last_emitted = None;
                dismissed = None;
                if let Some(window) = app.get_webview_window("context-bar") {
                    let _ = window.hide();
                }
                continue;
            };

            let key = selection_key(&selection);
            if dismissed.as_ref() == Some(&key) {
                candidate = None;
                continue;
            }
            if dismissed.is_some() {
                dismissed = None;
            }
            if candidate.as_ref().map(|item| &item.0) != Some(&key) {
                candidate = Some((key.clone(), Instant::now()));
                continue;
            }
            if candidate
                .as_ref()
                .is_some_and(|item| item.1.elapsed() < Duration::from_millis(config.delay_ms))
                || last_emitted.as_ref() == Some(&key)
            {
                continue;
            }

            let delivered = if let Some(window) = app.get_webview_window("context-bar") {
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
                // A hidden WKWebView may not execute injected event JavaScript until it is
                // visible. Show it first, then emit, and only suppress retries after both
                // operations succeed.
                window
                    .show()
                    .and_then(|_| window.emit("native-selection", &selection))
                    .is_ok()
            } else {
                false
            };
            if delivered {
                last_emitted = Some(key);
            }
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
    state
        .dismiss_current_selection
        .store(true, Ordering::SeqCst);
    app.get_webview_window("context-bar")
        .ok_or("Context Bar window is unavailable")?
        .hide()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn resize_context_bar(app: AppHandle, height: f64) -> Result<(), String> {
    let window = app
        .get_webview_window("context-bar")
        .ok_or("Context Bar window is unavailable")?;
    let height = height.clamp(76.0, 360.0);
    window
        .set_size(LogicalSize::new(780.0, height))
        .map_err(|error| error.to_string())?;

    // If the compact bar was placed above a bottom-edge selection, keep an expanded
    // result on-screen instead of allowing it to grow past the monitor boundary.
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let position = window.outer_position().map_err(|error| error.to_string())?;
    if let Some(monitor) = window
        .current_monitor()
        .map_err(|error| error.to_string())?
    {
        let monitor_bottom = monitor.position().y + monitor.size().height as i32;
        let margin = (8.0 * scale).round() as i32;
        let requested_bottom = position.y + (height * scale).round() as i32;
        if requested_bottom > monitor_bottom - margin {
            let y = (monitor_bottom - margin - (height * scale).round() as i32)
                .max(monitor.position().y + margin);
            window
                .set_position(PhysicalPosition::new(position.x, y))
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn set_context_bar_focusable(app: AppHandle, focusable: bool) -> Result<(), String> {
    let window = app
        .get_webview_window("context-bar")
        .ok_or("Context Bar window is unavailable")?;
    window
        .set_focusable(focusable)
        .map_err(|error| error.to_string())?;
    if focusable {
        window.set_focus().map_err(|error| error.to_string())?;
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    fn selection(text: &str, application: &str) -> NativeSelection {
        NativeSelection {
            text: text.into(),
            application: application.into(),
            window_title: None,
            process_id: 1,
            bounds: SelectionBounds {
                x: 0.0,
                y: 0.0,
                width: 10.0,
                height: 10.0,
            },
        }
    }

    #[test]
    fn selection_threshold_counts_characters_not_bytes() {
        let config = MonitorConfig {
            minimum_characters: 3,
            ..Default::default()
        };

        assert!(!selection_is_allowed(
            &selection("é🙂", "TextEdit"),
            &config
        ));
        assert!(selection_is_allowed(
            &selection("é🙂a", "TextEdit"),
            &config
        ));
    }

    #[test]
    fn excluded_application_matching_is_case_insensitive() {
        let config = MonitorConfig {
            minimum_characters: 1,
            excluded_applications: vec!["Keychain Access".into()],
            ..Default::default()
        };

        assert!(!selection_is_allowed(
            &selection("secret", "keychain access"),
            &config
        ));
        assert!(selection_is_allowed(
            &selection("safe", "TextEdit"),
            &config
        ));
    }

    #[test]
    fn selection_key_distinguishes_the_same_text_at_a_new_location() {
        let first = selection("same text", "TextEdit");
        let mut second = selection("same text", "TextEdit");
        second.bounds.x = 40.0;

        assert_ne!(selection_key(&first), selection_key(&second));
    }

    #[test]
    fn selection_key_ignores_sub_half_point_accessibility_jitter() {
        let first = selection("stable", "TextEdit");
        let mut second = selection("stable", "TextEdit");
        second.bounds.x = 0.12;
        second.bounds.y = 0.12;

        assert_eq!(selection_key(&first), selection_key(&second));
    }
}
