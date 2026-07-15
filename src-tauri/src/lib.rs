mod runtime;
mod scanner;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .manage(runtime::RuntimeManager::default())
        .invoke_handler(tauri::generate_handler![
            scanner::codex_status,
            scanner::scan_codex_environment,
            runtime::start_codex_run,
            runtime::respond_to_approval,
            runtime::interrupt_codex_run,
            runtime::stop_codex_run
        ])
        .run(tauri::generate_context!())
        .expect("error while running Latch Bar");
}
