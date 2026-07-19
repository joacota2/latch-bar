mod app_server;
mod platform;
mod runtime;
mod scanner;

use tauri::Manager;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

#[tauri::command]
fn studio_shortcut_registered(app: tauri::AppHandle) -> bool {
    app.global_shortcut().is_registered("Alt+Space")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(platform::PlatformState::default())
        .manage(runtime::RuntimeManager::default())
        .setup(|app| {
            if let Err(error) =
                app.global_shortcut()
                    .on_shortcut("Alt+Space", |app, _shortcut, event| {
                        if event.state != ShortcutState::Pressed {
                            return;
                        }
                        if let Some(window) = app.get_webview_window("studio") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    })
            {
                eprintln!("Could not register the Latch Studio shortcut: {error}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            studio_shortcut_registered,
            platform::platform_status,
            platform::repair_accessibility_permission,
            platform::context_bar_ready,
            platform::focus_selection_application,
            platform::start_selection_monitor,
            platform::set_overlay_pinned,
            platform::hide_context_bar,
            platform::resize_context_bar,
            platform::set_context_bar_focusable,
            platform::replace_selection,
            platform::copy_text,
            platform::open_studio,
            scanner::codex_status,
            scanner::scan_codex_environment,
            runtime::start_codex_run,
            runtime::continue_codex_run,
            runtime::respond_to_approval,
            runtime::interrupt_codex_run,
            runtime::stop_codex_run
        ])
        .run(tauri::generate_context!())
        .expect("error while running Latch Bar");
}
