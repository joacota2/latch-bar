//! Windows boundary for the next platform implementation.
//!
//! The frontend and command surface depend only on `PlatformAdapter`; a UI Automation
//! implementation can replace this module without changing the Context Bar protocol.
use super::{NativeSelection, PlatformAdapter, PlatformStatus, ReplacementResult};

#[derive(Default)]
pub struct WindowsAdapter;

impl PlatformAdapter for WindowsAdapter {
    fn status(&self, _prompt: bool) -> PlatformStatus {
        PlatformStatus {
            platform: "windows",
            supported: false,
            accessibility_trusted: false,
            permission_required: None,
            implementation: "uiautomation-pending",
        }
    }

    fn capture_selection(&self) -> Result<Option<NativeSelection>, String> {
        Err("Windows UI Automation selection capture is not implemented yet".into())
    }

    fn replace_selection(&self, _text: &str) -> Result<ReplacementResult, String> {
        Err("Windows UI Automation replacement is not implemented yet".into())
    }

    fn copy_text(&self, text: &str) -> Result<(), String> {
        let mut clipboard = arboard::Clipboard::new().map_err(|error| error.to_string())?;
        clipboard.set_text(text).map_err(|error| error.to_string())
    }
}
