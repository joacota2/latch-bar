use serde::{Deserialize, Serialize};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State};

const CONTEXT_BAR_INITIAL_WIDTH: f64 = 420.0;
const CONTEXT_BAR_MIN_WIDTH: f64 = 220.0;
const CONTEXT_BAR_MAX_WIDTH: f64 = 720.0;
// Includes transparent space above the 42px bar so native tooltips can render
// outside the solid surface without being clipped by the webview boundary.
const CONTEXT_BAR_COMPACT_HEIGHT: f64 = 86.0;
const CONTEXT_BAR_MAX_HEIGHT: f64 = 360.0;
const CONTEXT_BAR_MARGIN: f64 = 8.0;
const CONTEXT_BAR_GAP: f64 = 10.0;
const TRACKING_RETRY_INTERVAL: Duration = Duration::from_secs(2);
const TRACKING_FAILURES_BEFORE_RESTART: u32 = 3;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod unsupported;
#[cfg(target_os = "windows")]
mod windows;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSelection {
    pub selection_id: String,
    pub text: String,
    pub application: String,
    pub window_title: Option<String>,
    pub process_id: i32,
    pub bounds: SelectionBounds,
    pub replacement_capability: ReplacementCapability,
    pub replacement_unavailable_reason: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ReplacementCapability {
    None,
    Accessibility,
    ClipboardPaste,
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
    /// Whether the pointer and keyboard gesture monitor is installed. It requires
    /// Accessibility and improves capture in apps without a usable AX selection.
    pub selection_tracking: bool,
    /// Accessibility is granted but selection tracking repeatedly failed to start;
    /// relaunching Latch is the remaining remedy.
    pub restart_recommended: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplacementResult {
    pub method: &'static str,
    pub verified: bool,
}

pub trait PlatformAdapter: Send + Sync {
    fn status(&self, prompt: bool) -> PlatformStatus;
    fn start_selection_tracking(&self) -> Result<(), String> {
        Ok(())
    }
    fn selection_tracking_running(&self) -> bool {
        false
    }
    fn capture_selection(
        &self,
        excluded_applications: &[String],
    ) -> Result<Option<NativeSelection>, String>;
    fn replace_selection(
        &self,
        text: &str,
        selection_id: &str,
    ) -> Result<ReplacementResult, String>;
    fn copy_text(&self, text: &str) -> Result<(), String>;
}

#[derive(Default)]
pub struct PlatformState {
    adapter: Arc<Adapter>,
    monitor_started: AtomicBool,
    tracking_failures: Arc<AtomicU32>,
    pointer_monitor_started: AtomicBool,
    context_mouse_monitor_started: AtomicBool,
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
    selection_id: String,
    process_id: i32,
    text: String,
    replacement_capability: ReplacementCapability,
}

fn selection_key(selection: &NativeSelection) -> SelectionKey {
    SelectionKey {
        selection_id: selection.selection_id.clone(),
        process_id: selection.process_id,
        text: selection.text.clone(),
        replacement_capability: selection.replacement_capability,
    }
}

fn pointer_inside_context_bar(app: &AppHandle) -> bool {
    let Some(window) = app.get_webview_window("context-bar") else {
        return false;
    };
    if window.is_visible().ok() != Some(true) {
        return false;
    }
    let (Ok(cursor), Ok(origin), Ok(size)) = (
        window.cursor_position(),
        window.outer_position(),
        window.outer_size(),
    ) else {
        return false;
    };
    cursor.x >= origin.x as f64
        && cursor.y >= origin.y as f64
        && cursor.x < origin.x as f64 + size.width as f64
        && cursor.y < origin.y as f64 + size.height as f64
}

#[derive(Clone, Copy, Debug)]
struct LogicalRect {
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
}

fn clamp_axis(value: f64, minimum: f64, maximum: f64) -> f64 {
    if maximum < minimum {
        minimum
    } else {
        value.clamp(minimum, maximum)
    }
}

fn context_bar_position(
    selection: &SelectionBounds,
    work_area: LogicalRect,
    width: f64,
    height: f64,
) -> LogicalPosition<f64> {
    let minimum_x = work_area.left + CONTEXT_BAR_MARGIN;
    let maximum_x = work_area.right - CONTEXT_BAR_MARGIN - width;
    let x = clamp_axis(
        selection.x + selection.width / 2.0 - width / 2.0,
        minimum_x,
        maximum_x,
    );

    let minimum_y = work_area.top + CONTEXT_BAR_MARGIN;
    let maximum_y = work_area.bottom - CONTEXT_BAR_MARGIN - height;
    let below = selection.y + selection.height + CONTEXT_BAR_GAP;
    let above = selection.y - CONTEXT_BAR_GAP - height;
    let preferred_y = if below <= maximum_y {
        below
    } else if above >= minimum_y {
        above
    } else {
        below
    };
    let y = clamp_axis(preferred_y, minimum_y, maximum_y);
    LogicalPosition::new(x, y)
}

fn clamp_context_bar_position(
    position: LogicalPosition<f64>,
    work_area: LogicalRect,
    width: f64,
    height: f64,
) -> LogicalPosition<f64> {
    LogicalPosition::new(
        clamp_axis(
            position.x,
            work_area.left + CONTEXT_BAR_MARGIN,
            work_area.right - CONTEXT_BAR_MARGIN - width,
        ),
        clamp_axis(
            position.y,
            work_area.top + CONTEXT_BAR_MARGIN,
            work_area.bottom - CONTEXT_BAR_MARGIN - height,
        ),
    )
}

fn monitor_work_area(monitor: &tauri::Monitor) -> LogicalRect {
    let scale = monitor.scale_factor();
    let work_area = monitor.work_area();
    LogicalRect {
        left: work_area.position.x as f64 / scale,
        top: work_area.position.y as f64 / scale,
        right: (work_area.position.x as f64 + work_area.size.width as f64) / scale,
        bottom: (work_area.position.y as f64 + work_area.size.height as f64) / scale,
    }
}

#[cfg(target_os = "macos")]
fn context_bar_collection_behavior(
    mut behavior: objc2_app_kit::NSWindowCollectionBehavior,
) -> objc2_app_kit::NSWindowCollectionBehavior {
    use objc2_app_kit::NSWindowCollectionBehavior;

    behavior.remove(
        NSWindowCollectionBehavior::MoveToActiveSpace
            | NSWindowCollectionBehavior::FullScreenPrimary
            | NSWindowCollectionBehavior::FullScreenNone
            | NSWindowCollectionBehavior::Primary
            | NSWindowCollectionBehavior::Auxiliary,
    );
    behavior.insert(
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::CanJoinAllApplications
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::IgnoresCycle,
    );
    behavior
}

#[cfg(target_os = "macos")]
extern "C" fn context_panel_is_focusable(
    object: &objc2::runtime::AnyObject,
    _: objc2::runtime::Sel,
) -> objc2::runtime::Bool {
    // Preserve Tao's `focusable` ivar contract so `WebviewWindow::set_focusable`
    // continues to work after the native window becomes an NSPanel.
    #[allow(deprecated)]
    unsafe {
        *object.get_ivar("focusable")
    }
}

#[cfg(target_os = "macos")]
fn context_panel_class() -> &'static objc2::runtime::AnyClass {
    use objc2::{
        class,
        runtime::{AnyClass, Bool, ClassBuilder},
        sel,
    };
    use std::sync::OnceLock;

    static CLASS: OnceLock<&'static AnyClass> = OnceLock::new();
    CLASS.get_or_init(|| {
        let mut builder = ClassBuilder::new(c"LatchContextPanel", class!(NSPanel))
            .expect("LatchContextPanel must only be registered once");
        unsafe {
            builder.add_method(
                sel!(canBecomeMainWindow),
                context_panel_is_focusable as extern "C" fn(_, _) -> _,
            );
            builder.add_method(
                sel!(canBecomeKeyWindow),
                context_panel_is_focusable as extern "C" fn(_, _) -> _,
            );
        }
        builder.add_ivar::<Bool>(c"focusable");
        builder.register()
    })
}

#[cfg(target_os = "macos")]
fn panelize_context_bar(pointer: *mut std::ffi::c_void) -> Result<(), String> {
    use objc2::runtime::{AnyClass, AnyObject};

    unsafe extern "C" {
        fn object_setClass(object: *mut AnyObject, class: *const AnyClass) -> *const AnyClass;
    }

    let object = unsafe {
        (pointer as *mut AnyObject)
            .as_mut()
            .ok_or("Context Bar native object is unavailable")?
    };
    let panel_class = context_panel_class();
    let current_class = object.class();
    if current_class == panel_class {
        return Ok(());
    }
    if current_class.instance_size() != panel_class.instance_size() {
        return Err(format!(
            "Cannot convert {} ({} bytes) to {} ({} bytes)",
            current_class.name().to_string_lossy(),
            current_class.instance_size(),
            panel_class.name().to_string_lossy(),
            panel_class.instance_size()
        ));
    }
    let focusable_name = c"focusable";
    let current_focusable = current_class
        .instance_variable(focusable_name)
        .ok_or("The native Context Bar class has no focusable state")?;
    let panel_focusable = panel_class
        .instance_variable(focusable_name)
        .ok_or("The Context Bar panel class has no focusable state")?;
    if current_focusable.offset() != panel_focusable.offset() {
        return Err(format!(
            "Cannot preserve Context Bar focusability (ivar offsets {} and {} differ)",
            current_focusable.offset(),
            panel_focusable.offset()
        ));
    }

    // Tao allocates its NSWindow subclass with one `focusable` BOOL ivar. Our
    // NSPanel subclass has the same instance size and ivar layout, allowing the
    // webview and delegate to remain attached while AppKit treats this one window
    // as a full-screen-eligible panel. Studio remains an ordinary NSWindow.
    let previous = unsafe { object_setClass(object, panel_class) };
    if !std::ptr::eq(previous, current_class) {
        return Err("Context Bar native class changed concurrently".into());
    }
    Ok(())
}

#[tauri::command]
pub fn platform_status(state: State<PlatformState>, prompt: bool) -> PlatformStatus {
    let status = state.adapter.status(prompt);
    complete_status(&state, status)
}

fn complete_status(state: &PlatformState, mut status: PlatformStatus) -> PlatformStatus {
    status.monitor_running = state.monitor_started.load(Ordering::SeqCst);
    status.context_bar_ready = state.context_bar_ready.load(Ordering::SeqCst);
    status.selection_tracking = state.adapter.selection_tracking_running();
    status.restart_recommended = status.accessibility_trusted
        && !status.selection_tracking
        && state.tracking_failures.load(Ordering::SeqCst) >= TRACKING_FAILURES_BEFORE_RESTART;
    status
}

#[tauri::command]
pub fn open_privacy_settings(pane: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let anchor = match pane.as_str() {
            "accessibility" => "Privacy_Accessibility",
            "files" => "Privacy_FilesAndFolders",
            _ => return Err("Unknown privacy settings pane".into()),
        };
        std::process::Command::new("/usr/bin/open")
            .arg(format!(
                "x-apple.systempreferences:com.apple.preference.security?{anchor}"
            ))
            .status()
            .map_err(|error| format!("Could not open System Settings: {error}"))
            .and_then(|status| {
                status
                    .success()
                    .then_some(())
                    .ok_or_else(|| "Could not open System Settings".into())
            })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = pane;
        Err("Privacy settings are available on macOS only".into())
    }
}

#[tauri::command]
pub fn relaunch_app(window: tauri::WebviewWindow, app: AppHandle) -> Result<(), String> {
    if window.label() != "studio" {
        return Err("Relaunch Latch Bar from Studio.".into());
    }
    let runtime = app.state::<crate::runtime::RuntimeManager>();
    // Hold the same exclusive lease as an update through process exit. This
    // prevents a new run or editor from opening between the check and shutdown.
    let _permit = runtime.1.relaunch()?;
    runtime.shutdown();
    app.restart();
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
        Ok(complete_status(&state, state.adapter.status(true)))
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(complete_status(&state, state.adapter.status(false)))
    }
}

#[tauri::command]
pub fn context_bar_ready(app: AppHandle, state: State<PlatformState>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use block2::RcBlock;
        use objc2_app_kit::{NSApplication, NSEvent, NSEventMask, NSWindow, NSWindowStyleMask};
        use objc2_foundation::MainThreadMarker;
        let window = app
            .get_webview_window("context-bar")
            .ok_or("Context Bar window is unavailable")?;
        let pointer = window.ns_window().map_err(|error| error.to_string())?;
        panelize_context_bar(pointer)?;
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
        native_window.setHidesOnDeactivate(false);
        native_window
            .setStyleMask(native_window.styleMask() | NSWindowStyleMask::NonactivatingPanel);
        unsafe {
            let _: () = objc2::msg_send![native_window, setFloatingPanel: true];
            let _: () = objc2::msg_send![native_window, setBecomesKeyOnlyIfNeeded: true];
        }

        // This auxiliary window must accompany whichever application owns the active
        // Space, including a native full-screen Space. Remove mutually exclusive flags
        // before installing the desired behaviors.
        native_window.setCollectionBehavior(context_bar_collection_behavior(
            native_window.collectionBehavior(),
        ));

        if !state
            .context_mouse_monitor_started
            .swap(true, Ordering::SeqCst)
        {
            let context_window_address = pointer as usize;
            let block = RcBlock::new(move |event: std::ptr::NonNull<NSEvent>| -> *mut NSEvent {
                // AppKit invokes local event monitors on the main thread.
                let mtm = unsafe { MainThreadMarker::new_unchecked() };
                let event_ref = unsafe { event.as_ref() };
                let belongs_to_context_bar = event_ref.window(mtm).is_some_and(|window| {
                    (&*window as *const NSWindow as usize) == context_window_address
                });
                if belongs_to_context_bar {
                    // Suppress AppKit's normal mouse-down ordering. Without this, a
                    // click on the non-focusable overlay activates Latch and raises
                    // Studio. The redirect button still calls `open_studio` explicitly.
                    NSApplication::sharedApplication(mtm).preventWindowOrdering();
                }
                event.as_ptr()
            });
            let monitor = unsafe {
                NSEvent::addLocalMonitorForEventsMatchingMask_handler(
                    NSEventMask::LeftMouseDown,
                    &block,
                )
            };
            let Some(monitor) = monitor else {
                state
                    .context_mouse_monitor_started
                    .store(false, Ordering::SeqCst);
                return Err("Could not install the Context Bar mouse monitor".into());
            };
            // AppKit owns the event monitor for the lifetime of the application. Keep
            // its token alive so the monitor cannot be automatically removed.
            std::mem::forget(monitor);
        }
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
        app.state::<crate::runtime::RuntimeManager>().shutdown();
        state.overlay_pinned.store(false, Ordering::SeqCst);
        if let Some(window) = app.get_webview_window("context-bar") {
            let _ = window.hide();
        }
    }
    // Gesture tracking is an enhancement to Accessibility capture. The monitor loop
    // starts it once Accessibility is granted and keeps retrying if macOS refuses
    // the passive event tap, so the AX-only monitor stays operational meanwhile.
    if enabled && state.adapter.status(false).accessibility_trusted {
        if let Err(error) = state.adapter.start_selection_tracking() {
            eprintln!("Selection gesture tracking is unavailable: {error}");
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
    let tracking_failures = state.tracking_failures.clone();
    std::thread::spawn(move || {
        let mut last_tracking_attempt: Option<Instant> = None;
        let mut candidate: Option<(SelectionKey, Instant)> = None;
        let mut last_emitted: Option<SelectionKey> = None;
        let mut dismissed: Option<SelectionKey> = None;
        let mut missed_since: Option<Instant> = None;
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
                missed_since = None;
                if let Some(window) = app.get_webview_window("context-bar") {
                    let _ = window.hide();
                }
                continue;
            }
            if !context_bar_ready.load(Ordering::SeqCst) {
                continue;
            }
            let trusted = adapter.status(false).accessibility_trusted;
            if trusted
                && !adapter.selection_tracking_running()
                && last_tracking_attempt.is_none_or(|at| at.elapsed() >= TRACKING_RETRY_INTERVAL)
            {
                last_tracking_attempt = Some(Instant::now());
                match adapter.start_selection_tracking() {
                    Ok(()) => tracking_failures.store(0, Ordering::SeqCst),
                    Err(error) => {
                        if tracking_failures.fetch_add(1, Ordering::SeqCst) == 0 {
                            eprintln!("Selection gesture tracking is unavailable: {error}");
                        }
                    }
                }
            }
            if pinned.load(Ordering::SeqCst) || pointer_inside_context_bar(&app) {
                continue;
            }

            if dismiss_current_selection.swap(false, Ordering::SeqCst) {
                dismissed = last_emitted
                    .take()
                    .or_else(|| candidate.as_ref().map(|item| item.0.clone()));
                candidate = None;
            }

            let selection = match adapter.capture_selection(&config.excluded_applications) {
                Ok(selection) => selection,
                Err(error) => {
                    eprintln!("Native selection capture failed: {error}");
                    None
                }
            }
            .filter(|selection| selection_is_allowed(selection, &config));

            // Capture may take several hundred milliseconds. Do not publish a new
            // selection after the user has begun interacting with the overlay.
            if pinned.load(Ordering::SeqCst) || pointer_inside_context_bar(&app) {
                continue;
            }
            let Some(selection) = selection else {
                let had_selection = candidate.is_some() || last_emitted.is_some();
                let missed = missed_since.get_or_insert_with(Instant::now);
                if had_selection && missed.elapsed() < Duration::from_millis(480) {
                    continue;
                }
                candidate = None;
                last_emitted = None;
                dismissed = None;
                missed_since = None;
                if let Some(window) = app.get_webview_window("context-bar") {
                    let _ = window.hide();
                }
                continue;
            };
            missed_since = None;

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
                let scale = window.scale_factor().unwrap_or(1.0);
                let size = window.outer_size().ok();
                let width = size
                    .as_ref()
                    .map_or(CONTEXT_BAR_INITIAL_WIDTH, |size| size.width as f64 / scale);
                let height = size.as_ref().map_or(CONTEXT_BAR_COMPACT_HEIGHT, |size| {
                    size.height as f64 / scale
                });
                let monitor = window
                    .monitor_from_point(
                        selection.bounds.x + selection.bounds.width / 2.0,
                        selection.bounds.y + selection.bounds.height / 2.0,
                    )
                    .ok()
                    .flatten()
                    .or_else(|| window.primary_monitor().ok().flatten());
                let position = monitor
                    .as_ref()
                    .map(|monitor| {
                        context_bar_position(
                            &selection.bounds,
                            monitor_work_area(monitor),
                            width,
                            height,
                        )
                    })
                    .unwrap_or_else(|| {
                        LogicalPosition::new(
                            (selection.bounds.x + selection.bounds.width / 2.0 - width / 2.0)
                                .max(CONTEXT_BAR_MARGIN),
                            (selection.bounds.y + selection.bounds.height + CONTEXT_BAR_GAP)
                                .max(CONTEXT_BAR_MARGIN),
                        )
                    });
                // A hidden WKWebView may not execute injected event JavaScript until it is
                // visible. Show it first, then emit, and only suppress retries after both
                // operations succeed.
                window
                    .set_position(position)
                    .and_then(|_| window.show())
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
pub fn resize_context_bar(
    app: AppHandle,
    height: f64,
    width: Option<f64>,
    anchor_x: Option<f64>,
) -> Result<(), String> {
    let window = app
        .get_webview_window("context-bar")
        .ok_or("Context Bar window is unavailable")?;
    let height = height.clamp(CONTEXT_BAR_COMPACT_HEIGHT, CONTEXT_BAR_MAX_HEIGHT);
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let size = window.outer_size().map_err(|error| error.to_string())?;
    let current_width = size.width as f64 / scale;
    let width = width
        .unwrap_or(current_width)
        .clamp(CONTEXT_BAR_MIN_WIDTH, CONTEXT_BAR_MAX_WIDTH);
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let centered_position = LogicalPosition::new(
        anchor_x.unwrap_or(position.x as f64 / scale + current_width / 2.0) - width / 2.0,
        position.y as f64 / scale,
    );
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|error| error.to_string())?;

    // Re-clamp after every expansion so results, approvals, and the agent picker stay
    // inside the visible work area rather than growing behind the Dock or menu bar. Keep
    // the previous center point stable as the compact bar grows or shrinks around it.
    let target_position = if let Some(monitor) = window
        .current_monitor()
        .map_err(|error| error.to_string())?
    {
        clamp_context_bar_position(
            centered_position,
            monitor_work_area(&monitor),
            width,
            height,
        )
    } else {
        centered_position
    };
    window
        .set_position(target_position)
        .map_err(|error| error.to_string())?;
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
pub async fn replace_selection(
    state: State<'_, PlatformState>,
    text: String,
    selection_id: String,
) -> Result<ReplacementResult, String> {
    let adapter = state.adapter.clone();
    // The frontend owns dismissal. In particular, an unverified dispatch must
    // leave the result pinned so the user can inspect it and copy the answer.
    tauri::async_runtime::spawn_blocking(move || adapter.replace_selection(&text, &selection_id))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn copy_text(state: State<PlatformState>, text: String) -> Result<(), String> {
    state.adapter.copy_text(&text)
}

#[tauri::command]
pub fn open_studio(app: AppHandle, show_runs: Option<bool>) -> Result<(), String> {
    let window = app
        .get_webview_window("studio")
        .ok_or("Studio window is unavailable")?;
    window.show().map_err(|error| error.to_string())?;
    if show_runs == Some(true) {
        window
            .emit("show-runs", ())
            .map_err(|error| error.to_string())?;
    }
    window.set_focus().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn selection(text: &str, application: &str) -> NativeSelection {
        NativeSelection {
            selection_id: "selection-1".into(),
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
            replacement_capability: ReplacementCapability::None,
            replacement_unavailable_reason: None,
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
        second.selection_id = "selection-2".into();

        assert_ne!(selection_key(&first), selection_key(&second));
    }

    #[test]
    fn selection_key_ignores_geometry_changes_for_the_same_capture() {
        let first = selection("stable", "TextEdit");
        let mut second = selection("stable", "TextEdit");
        second.bounds.x = 240.0;
        second.bounds.y = 120.0;

        assert_eq!(selection_key(&first), selection_key(&second));
    }

    #[test]
    fn selection_key_detects_replacement_capability_changes() {
        let first = selection("same text", "TextEdit");
        let mut second = first.clone();
        second.replacement_capability = ReplacementCapability::Accessibility;

        assert_ne!(selection_key(&first), selection_key(&second));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn context_bar_can_join_other_app_fullscreen_spaces() {
        use objc2_app_kit::NSWindowCollectionBehavior;

        let behavior = context_bar_collection_behavior(
            NSWindowCollectionBehavior::MoveToActiveSpace
                | NSWindowCollectionBehavior::Primary
                | NSWindowCollectionBehavior::FullScreenPrimary,
        );

        assert!(behavior.contains(NSWindowCollectionBehavior::CanJoinAllSpaces));
        assert!(behavior.contains(NSWindowCollectionBehavior::CanJoinAllApplications));
        assert!(behavior.contains(NSWindowCollectionBehavior::FullScreenAuxiliary));
        assert!(!behavior.intersects(
            NSWindowCollectionBehavior::MoveToActiveSpace
                | NSWindowCollectionBehavior::Primary
                | NSWindowCollectionBehavior::Auxiliary
                | NSWindowCollectionBehavior::FullScreenPrimary
                | NSWindowCollectionBehavior::FullScreenNone
        ));
    }

    fn work_area() -> LogicalRect {
        LogicalRect {
            left: 0.0,
            top: 0.0,
            right: 1440.0,
            bottom: 900.0,
        }
    }

    #[test]
    fn context_bar_flips_above_a_bottom_edge_selection() {
        let bounds = SelectionBounds {
            x: 700.0,
            y: 860.0,
            width: 40.0,
            height: 20.0,
        };

        let position = context_bar_position(
            &bounds,
            work_area(),
            CONTEXT_BAR_INITIAL_WIDTH,
            CONTEXT_BAR_COMPACT_HEIGHT,
        );

        assert_eq!(
            position.y,
            bounds.y - CONTEXT_BAR_GAP - CONTEXT_BAR_COMPACT_HEIGHT
        );
        assert!(position.y + CONTEXT_BAR_COMPACT_HEIGHT <= 892.0);
    }

    #[test]
    fn context_bar_is_clamped_at_both_horizontal_edges() {
        let mut bounds = SelectionBounds {
            x: 0.0,
            y: 100.0,
            width: 20.0,
            height: 20.0,
        };
        let left = context_bar_position(
            &bounds,
            work_area(),
            CONTEXT_BAR_INITIAL_WIDTH,
            CONTEXT_BAR_COMPACT_HEIGHT,
        );
        bounds.x = 1420.0;
        let right = context_bar_position(
            &bounds,
            work_area(),
            CONTEXT_BAR_INITIAL_WIDTH,
            CONTEXT_BAR_COMPACT_HEIGHT,
        );

        assert_eq!(left.x, CONTEXT_BAR_MARGIN);
        assert_eq!(
            right.x,
            1440.0 - CONTEXT_BAR_MARGIN - CONTEXT_BAR_INITIAL_WIDTH
        );
    }

    #[test]
    fn expanded_context_bar_stays_inside_the_visible_work_area() {
        let clamped = clamp_context_bar_position(
            LogicalPosition::new(1200.0, 820.0),
            LogicalRect {
                left: 80.0,
                top: 24.0,
                right: 1440.0,
                bottom: 900.0,
            },
            CONTEXT_BAR_INITIAL_WIDTH,
            300.0,
        );

        assert_eq!(
            clamped.x,
            1440.0 - CONTEXT_BAR_MARGIN - CONTEXT_BAR_INITIAL_WIDTH
        );
        assert_eq!(clamped.y, 592.0);
    }
}
