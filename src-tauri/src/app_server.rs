use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Stdio},
    sync::mpsc::{self, Receiver},
    thread,
    time::{Duration, Instant},
};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

pub(crate) struct AppServerClient {
    child: Child,
    stdin: ChildStdin,
    messages: Receiver<Value>,
    next_request_id: u64,
    pub(crate) codex_home: String,
    pub(crate) user_agent: String,
}

impl AppServerClient {
    pub(crate) fn connect(profile: Option<&str>, cwd: Option<&str>) -> Result<Self, String> {
        let mut command = crate::scanner::codex_app_server_command(profile);
        if let Some(cwd) = cwd.filter(|cwd| std::path::Path::new(cwd).is_dir()) {
            command.current_dir(cwd);
        }
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(crate::scanner::codex_spawn_error)?;
        let stdin = child
            .stdin
            .take()
            .ok_or("Codex app-server has no input stream")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("Codex app-server has no output stream")?;
        let (sender, messages) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Ok(message) = serde_json::from_str::<Value>(&line) {
                    if sender.send(message).is_err() {
                        break;
                    }
                }
            }
        });

        let mut client = Self {
            child,
            stdin,
            messages,
            next_request_id: 1,
            codex_home: String::new(),
            user_agent: String::new(),
        };
        let initialized = client.request_with_id(
            0,
            "initialize",
            json!({
                "clientInfo": {
                    "name": "latch_bar",
                    "title": "Latch Bar",
                    "version": env!("CARGO_PKG_VERSION")
                },
                "capabilities": { "experimentalApi": true }
            }),
        )?;
        client.codex_home = initialized
            .get("codexHome")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        client.user_agent = initialized
            .get("userAgent")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        client.notify("initialized", Value::Null)?;
        Ok(client)
    }

    pub(crate) fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_request_id;
        self.next_request_id += 1;
        self.request_with_id(id, method, params)
    }

    pub(crate) fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        let value = if params.is_null() {
            json!({ "method": method })
        } else {
            json!({ "method": method, "params": params })
        };
        self.send(&value)
    }

    fn request_with_id(&mut self, id: u64, method: &str, params: Value) -> Result<Value, String> {
        let value = if params.is_null() {
            json!({ "method": method, "id": id })
        } else {
            json!({ "method": method, "id": id, "params": params })
        };
        self.send(&value)?;
        let deadline = Instant::now() + REQUEST_TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(format!("Codex app-server request {method} timed out"));
            }
            let message = self
                .messages
                .recv_timeout(remaining)
                .map_err(|error| match error {
                    mpsc::RecvTimeoutError::Timeout => {
                        format!("Codex app-server request {method} timed out")
                    }
                    mpsc::RecvTimeoutError::Disconnected => {
                        format!("Codex app-server stopped while handling {method}")
                    }
                })?;
            if message.get("method").is_some() || message.get("id") != Some(&json!(id)) {
                continue;
            }
            if let Some(error) = message.get("error") {
                let detail = error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown app-server error");
                return Err(format!("{method}: {detail}"));
            }
            return message
                .get("result")
                .cloned()
                .ok_or_else(|| format!("{method}: response did not include a result"));
        }
    }

    fn send(&mut self, value: &Value) -> Result<(), String> {
        writeln!(self.stdin, "{value}").map_err(|error| error.to_string())?;
        self.stdin.flush().map_err(|error| error.to_string())
    }
}

impl Drop for AppServerClient {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
