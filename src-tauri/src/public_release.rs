//! Public updates use the configured HTTPS endpoint without GitHub credentials.
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_updater::{Update, UpdaterExt};

pub async fn check(app: &AppHandle) -> Result<Option<Update>, String> {
    // Keep the official updater's pinned-key signature verification and explicit
    // distribution/test endpoint overrides. No CLI or Authorization header is needed.
    app.updater_builder()
        .timeout(Duration::from_secs(20))
        .version_comparator(|current, release| {
            release.version.pre.is_empty() && release.version > current
        })
        .build()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())
}
