use serde::Serialize;
use std::{fs, path::PathBuf};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderAccess {
    folder: String,
    path: String,
    granted: bool,
    error: Option<String>,
}

fn folder_path(folder: &str) -> Option<PathBuf> {
    let home = dirs::home_dir();
    match folder {
        "documents" => dirs::document_dir().or_else(|| home.map(|home| home.join("Documents"))),
        "desktop" => dirs::desktop_dir().or_else(|| home.map(|home| home.join("Desktop"))),
        "downloads" => dirs::download_dir().or_else(|| home.map(|home| home.join("Downloads"))),
        _ => None,
    }
}

fn request(folder: String) -> FolderAccess {
    let Some(path) = folder_path(&folder) else {
        return FolderAccess {
            folder,
            path: String::new(),
            granted: false,
            error: Some("Unknown folder".into()),
        };
    };
    // macOS privacy protection prompts on the first read of a protected folder and
    // blocks until the person answers. Codex runs inherit Latch's grant, so asking
    // here keeps the prompt out of a run that is already underway.
    let mut result = fs::read_dir(&path).map(|_| ());
    if folder == "documents" && result.is_ok() {
        result = crate::runtime::projectless_cwd()
            .map(|_| ())
            .map_err(std::io::Error::other);
    }
    FolderAccess {
        folder,
        path: path.to_string_lossy().into_owned(),
        granted: result.is_ok(),
        error: result.err().map(|error| error.to_string()),
    }
}

#[tauri::command]
pub async fn request_folder_access(folders: Vec<String>) -> Result<Vec<FolderAccess>, String> {
    tauri::async_runtime::spawn_blocking(move || folders.into_iter().map(request).collect())
        .await
        .map_err(|error| error.to_string())
}
