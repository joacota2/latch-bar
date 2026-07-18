use super::{NativeSelection, PlatformAdapter, PlatformStatus, ReplacementResult};

#[derive(Default)]
pub struct UnsupportedAdapter;

impl PlatformAdapter for UnsupportedAdapter {
    fn status(&self, _prompt: bool) -> PlatformStatus {
        PlatformStatus {
            platform: "unsupported",
            supported: false,
            accessibility_trusted: false,
            permission_required: None,
            implementation: "unsupported",
            monitor_running: false,
            context_bar_ready: false,
        }
    }
    fn capture_selection(
        &self,
        _excluded_applications: &[String],
    ) -> Result<Option<NativeSelection>, String> {
        Ok(None)
    }
    fn replace_selection(&self, _text: &str) -> Result<ReplacementResult, String> {
        Err("Selection replacement is not supported on this platform".into())
    }
    fn copy_text(&self, text: &str) -> Result<(), String> {
        let mut clipboard = arboard::Clipboard::new().map_err(|error| error.to_string())?;
        clipboard.set_text(text).map_err(|error| error.to_string())
    }
}
