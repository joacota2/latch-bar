use crate::activity::{ActivityGate, RunActivity, RunPermit};
use crate::runtime_events::RuntimeEvents;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tauri::{AppHandle, State};
use uuid::Uuid;

const CONFIG_REQUEST_ID: &str = "latch:config";
const TITLE_THREAD_REQUEST_ID: &str = "latch:title:thread";
const TITLE_TURN_REQUEST_ID: &str = "latch:title:turn";
const TITLE_NAME_REQUEST_ID: &str = "latch:title:name";
const TITLE_UNSUBSCRIBE_REQUEST_ID: &str = "latch:title:unsubscribe";
const TITLE_MODEL: &str = "gpt-5.4-mini";

#[derive(Clone, Default)]
pub struct RuntimeManager(
    Arc<Mutex<HashMap<String, RuntimeProcess>>>,
    pub ActivityGate,
    Arc<AtomicU64>,
);

struct RuntimeProcess {
    activity: RunActivity,
    approvals: Arc<Mutex<crate::approvals::PendingApprovals>>,
    pending_turn_request: Arc<AtomicU64>,
    starting: Arc<AtomicBool>,
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
    thread_id: Arc<Mutex<Option<String>>>,
    turn_id: Arc<Mutex<Option<String>>>,
    next_request_id: AtomicU64,
    effort: Option<String>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeConfig {
    model: Option<String>,
    reasoning_effort: Option<String>,
    service_tier: Option<String>,
    sandbox: String,
    permission_profile: Option<String>,
    approval_policy: String,
    codex_profile: Option<String>,
    workspace_mode: String,
    fixed_workspace_path: Option<String>,
    #[serde(default)]
    enabled_mcp_servers: Vec<String>,
    #[serde(default)]
    enabled_skills: Vec<String>,
    #[serde(default)]
    resolved_skills: Vec<ResolvedSkill>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ResolvedSkill {
    id: String,
    name: String,
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRunResponse {
    run_id: String,
    prompt: String,
}

fn projectless_cwd_from_documents(documents: &Path) -> PathBuf {
    documents.join("Codex").join("Latch Bar")
}

pub(crate) fn projectless_path() -> Result<PathBuf, String> {
    let documents = dirs::document_dir()
        .or_else(|| dirs::home_dir().map(|home| home.join("Documents")))
        .ok_or("Could not resolve a Documents directory for projectless runs")?;
    Ok(projectless_cwd_from_documents(&documents))
}

pub(crate) fn projectless_cwd() -> Result<String, String> {
    let cwd = projectless_path()?;
    fs::create_dir_all(&cwd)
        .map_err(|error| format!("Could not create the projectless run directory: {error}"))?;
    Ok(cwd.to_string_lossy().into_owned())
}

fn compact_title(value: &str) -> Option<String> {
    let mut title = value
        .lines()
        .find(|line| !line.trim().is_empty())?
        .trim()
        .strip_prefix("Title:")
        .unwrap_or(value.lines().find(|line| !line.trim().is_empty())?.trim())
        .trim()
        .trim_matches(|character| matches!(character, '`' | '"' | '\'' | '“' | '”' | '‘' | '’'))
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    title = title.trim_end_matches(['.', '?', '!']).trim().to_string();
    if title.is_empty() {
        return None;
    }
    let characters = title.chars().collect::<Vec<_>>();
    if characters.len() > 36 {
        title = format!(
            "{}…",
            characters[..35].iter().collect::<String>().trim_end()
        );
    }
    Some(title)
}

fn fallback_title(source: &str) -> Option<String> {
    source
        .lines()
        .find_map(|line| line.trim().strip_prefix("Task:"))
        .and_then(compact_title)
        .or_else(|| compact_title(source))
}

fn parse_generated_title(output: &str) -> Option<String> {
    serde_json::from_str::<Value>(output)
        .ok()
        .and_then(|value| {
            value
                .get("title")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .and_then(|title| compact_title(&title))
}

fn title_generation_prompt(source: &str) -> String {
    let source = source.chars().take(2_000).collect::<String>();
    format!(
        "You are a helpful assistant. Generate a concise UI title for the task below.\n\
         Write only the structured title field.\n\
         Rules:\n\
         - Use at most 36 characters and fewer than 5 words where possible.\n\
         - Capture the core action or question.\n\
         - Use an imperative verb first when appropriate.\n\
         - Write in the user's language.\n\
         - Do not use quotes, markdown, or trailing punctuation.\n\
         - Do not answer the task.\n\n\
         Task context:\n{source}"
    )
}

fn send(stdin: &Arc<Mutex<ChildStdin>>, value: &Value) -> Result<(), String> {
    let mut stream = stdin
        .lock()
        .map_err(|_| "Codex input stream is unavailable")?;
    writeln!(stream, "{}", value).map_err(|error| error.to_string())?;
    stream.flush().map_err(|error| error.to_string())
}

fn runtime_mcp_overrides(result: Option<&Value>, enabled: &[String]) -> Result<Value, String> {
    let config = result
        .and_then(|result| result.get("config"))
        .and_then(Value::as_object)
        .ok_or("Could not read the effective MCP configuration; the run was not started")?;
    let configured = match config.get("mcp_servers") {
        Some(Value::Object(servers)) => servers.keys().cloned().collect::<Vec<_>>(),
        Some(Value::Null) | None => Vec::new(),
        _ => return Err("Codex returned an invalid MCP configuration".into()),
    };
    Ok(crate::scanner::mcp_config_overrides(&configured, enabled))
}

fn unsupported_request_response(message: &Value) -> Option<Value> {
    let id = message.get("id")?;
    let method = message.get("method")?.as_str()?;
    if matches!(
        method,
        "item/commandExecution/requestApproval"
            | "item/fileChange/requestApproval"
            | "item/permissions/requestApproval"
    ) {
        return None;
    }
    Some(
        json!({"id": id, "error": {"code": -32601, "message": format!("Latch does not support {method}; use Codex for this interaction")}}),
    )
}

fn approval_policy(value: &str) -> &'static str {
    match value {
        "always-ask" => "untrusted",
        "never" => "never",
        _ => "on-request",
    }
}

fn sandbox(value: &str) -> &'static str {
    match value {
        "workspace-write" => "workspace-write",
        "full-access" => "danger-full-access",
        _ => "read-only",
    }
}

#[tauri::command]
pub async fn start_codex_run(
    app: AppHandle,
    manager: State<'_, RuntimeManager>,
    agent: AgentRuntimeConfig,
    prompt: String,
    title_source: String,
) -> Result<StartRunResponse, String> {
    // Reserve before spawning, including time spent resolving the workspace.
    let generation = manager.2.load(Ordering::SeqCst);
    let permit = manager.1.start_run()?;
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        start_codex_run_blocking(
            RuntimeEvents::tauri(app),
            manager,
            agent,
            prompt,
            title_source,
            (permit, generation),
            Driver {
                command: &crate::scanner::codex_app_server_command,
                turn_start_timeout: std::time::Duration::from_secs(30),
            },
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

struct Driver<'a> {
    command: &'a dyn Fn(Option<&str>) -> Result<Command, String>,
    turn_start_timeout: std::time::Duration,
}

fn start_codex_run_blocking(
    app: RuntimeEvents,
    manager: RuntimeManager,
    agent: AgentRuntimeConfig,
    prompt: String,
    title_source: String,
    lease: (RunPermit, u64),
    driver: Driver<'_>,
) -> Result<StartRunResponse, String> {
    let (permit, generation) = lease;
    let run_id = Uuid::new_v4().to_string();
    let cwd = Some(match agent.workspace_mode.as_str() {
        "fixed" => {
            let path = agent
                .fixed_workspace_path
                .clone()
                .filter(|path| !path.trim().is_empty())
                .map(crate::scanner::expand_user_path)
                .ok_or("A fixed workspace path is required")?;
            let path = fs::canonicalize(&path)
                .map_err(|error| format!("Workspace is unavailable: {error}"))?;
            if !path.is_dir() {
                return Err("Workspace must be a directory".into());
            }
            path.to_string_lossy().into_owned()
        }
        "none" => projectless_cwd()?,
        _ => return Err("Resolve the workspace before starting a run".into()),
    });
    let profile = agent
        .codex_profile
        .as_deref()
        .filter(|profile| !profile.is_empty() && *profile != "default");
    let mut command = (driver.command)(profile)?;
    if let Some(cwd) = cwd
        .as_deref()
        .filter(|cwd| std::path::Path::new(cwd).is_dir())
    {
        command.current_dir(cwd);
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(crate::scanner::codex_spawn_error)?;
    let stdin = Arc::new(Mutex::new(
        child
            .stdin
            .take()
            .ok_or("Codex app-server has no input stream")?,
    ));
    let stdout = child
        .stdout
        .take()
        .ok_or("Codex app-server has no output stream")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("Codex app-server has no error stream")?;
    let child = Arc::new(Mutex::new(child));
    let thread_id = Arc::new(Mutex::new(None));
    let turn_id = Arc::new(Mutex::new(None));
    let effort = agent
        .reasoning_effort
        .clone()
        .filter(|value| value != "default");
    let starting = Arc::new(AtomicBool::new(true));
    let activity = RunActivity::new(permit);
    let pending_turn_request = Arc::new(AtomicU64::new(2));
    let approvals = Arc::new(Mutex::new(crate::approvals::PendingApprovals::default()));
    let process = RuntimeProcess {
        approvals: approvals.clone(),
        activity: activity.clone(),
        pending_turn_request: pending_turn_request.clone(),
        starting: starting.clone(),
        child: child.clone(),
        stdin: stdin.clone(),
        thread_id: thread_id.clone(),
        turn_id: turn_id.clone(),
        next_request_id: AtomicU64::new(3),
        effort: effort.clone(),
    };
    {
        let mut processes = manager.0.lock().map_err(|_| "Runtime state unavailable")?;
        if manager.2.load(Ordering::SeqCst) != generation {
            return Err("This launch was cancelled while Latch state changed".into());
        }
        processes.insert(run_id.clone(), process);
    }

    if let Err(error) = send(
        &stdin,
        &json!({"method":"initialize","id":0,"params":{"clientInfo":{"name":"latch_bar","title":"Latch Bar","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}}}),
    ) {
        manager
            .0
            .lock()
            .map_err(|_| "Runtime manager is unavailable")?
            .remove(&run_id);
        return Err(error);
    }
    let model = agent
        .model
        .clone()
        .filter(|model| !model.is_empty() && model != "default");
    let service_tier = agent
        .service_tier
        .clone()
        .filter(|tier| !tier.is_empty() && tier != "default");
    let permission_profile = agent
        .permission_profile
        .clone()
        .filter(|profile| !profile.is_empty() && profile != "default");
    let mut thread_params = serde_json::Map::new();
    if let Some(model) = model {
        thread_params.insert("model".into(), json!(model));
    }
    if let Some(service_tier) = service_tier {
        thread_params.insert("serviceTier".into(), json!(service_tier));
    }
    if let Some(cwd) = cwd.as_ref() {
        thread_params.insert("cwd".into(), json!(cwd));
    }
    thread_params.insert(
        "approvalPolicy".into(),
        json!(approval_policy(&agent.approval_policy)),
    );
    if let Some(permission_profile) = permission_profile {
        thread_params.insert("permissions".into(), json!(permission_profile));
    } else {
        thread_params.insert("sandbox".into(), json!(sandbox(&agent.sandbox)));
    }

    thread_params.insert("serviceName".into(), json!("latch_bar"));
    thread_params.insert("ephemeral".into(), json!(false));
    let thread_start_request = json!({"method":"thread/start","id":1,"params":thread_params});
    let title_thread_start_request = json!({
        "method": "thread/start",
        "id": TITLE_THREAD_REQUEST_ID,
        "params": {
            "model": TITLE_MODEL,
            "cwd": cwd,
            "approvalPolicy": "never",
            "permissions": ":read-only",
            "runtimeWorkspaceRoots": [],
            "config": {
                "features.enable_fanout": false,
                "features.hooks": false,
                "features.multi_agent": false,
                "features.multi_agent_v2": false,
                "web_search": "disabled"
            },
            "serviceName": "latch_bar",
            "ephemeral": true
        }
    });

    {
        let processes = manager.0.lock().map_err(|_| "Runtime state unavailable")?;
        if let Some(process) = processes.get(&run_id) {
            process.deadline(app.clone(), run_id.clone(), 2, driver.turn_start_timeout);
        }
    }
    let event_name = format!("codex-event:{run_id}");
    let generic_run_id = run_id.clone();
    let stdin_reader = stdin.clone();
    let prompt_reader = prompt.clone();
    let title_prompt = title_generation_prompt(&title_source);
    let title_fallback = fallback_title(&title_source);
    let enabled_mcp_servers = agent.enabled_mcp_servers.clone();
    let enabled_skills = agent.enabled_skills.iter().collect::<HashSet<_>>();
    let skill_inputs = agent
        .resolved_skills
        .iter()
        .filter(|skill| enabled_skills.contains(&skill.id))
        .map(|skill| json!({ "type": "skill", "name": skill.name, "path": skill.path }))
        .collect::<Vec<_>>();
    let event_app = app.clone();
    std::thread::spawn(move || {
        let mut retired_turns = HashSet::<String>::new();
        let mut initialized = false;
        let mut configured = false;
        let mut title_thread_id: Option<String> = None;
        let mut title_output = String::new();
        let mut pending_title: Option<String> = None;
        let mut title_name_sent = false;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let response_id = message.get("id").and_then(Value::as_u64);
            if message.get("method").is_none()
                && response_id
                    .is_some_and(|id| id >= 2 && id != pending_turn_request.load(Ordering::SeqCst))
            {
                continue;
            }
            if response_id == Some(0) && initialized {
                continue;
            }
            if message.get("id") == Some(&json!(0))
                && message.get("result").is_some()
                && send(&stdin_reader, &json!({"method":"initialized"})).is_ok()
            {
                initialized = true;
                let _ = send(
                    &stdin_reader,
                    &json!({"id": CONFIG_REQUEST_ID, "method": "config/read", "params": {"includeLayers": false}}),
                );
            }
            if message.get("id") == Some(&json!(CONFIG_REQUEST_ID)) {
                if configured {
                    continue;
                }
                configured = true;
                match runtime_mcp_overrides(message.get("result"), &enabled_mcp_servers) {
                    Ok(config) => {
                        let mut request = thread_start_request.clone();
                        request["params"]["config"] = config;
                        let _ = send(&stdin_reader, &request);
                        let mut title_request = title_thread_start_request.clone();
                        if let Ok(disabled) = runtime_mcp_overrides(message.get("result"), &[]) {
                            title_request["params"]["config"]["mcp_servers"] =
                                disabled["mcp_servers"].clone();
                        }
                        let _ = send(&stdin_reader, &title_request);
                    }
                    Err(error) => {
                        starting.store(false, Ordering::SeqCst);
                        activity.finish();
                        let _ = event_app.emit("codex-event", json!({"runId": generic_run_id, "message": {"error": {"message": error}}}));
                    }
                }
                continue;
            }
            if message.get("id") == Some(&json!(1)) {
                if thread_id.lock().expect("thread id lock").is_some() {
                    continue;
                }
                if let Some(id) = message.pointer("/result/thread/id").and_then(Value::as_str) {
                    *thread_id.lock().expect("thread id lock") = Some(id.to_string());
                    let mut input =
                        vec![json!({"type":"text","text":prompt_reader,"text_elements":[]})];
                    input.extend(skill_inputs.clone());
                    let _ = send(
                        &stdin_reader,
                        &json!({"method":"turn/start","id":2,"params":{"threadId":id,"input":input,"effort":effort}}),
                    );
                }
            }
            if message.get("id") == Some(&json!(TITLE_THREAD_REQUEST_ID)) {
                if let Some(id) = message.pointer("/result/thread/id").and_then(Value::as_str) {
                    title_thread_id = Some(id.to_string());
                    let _ = send(
                        &stdin_reader,
                        &json!({
                            "method": "turn/start",
                            "id": TITLE_TURN_REQUEST_ID,
                            "params": {
                                "threadId": id,
                                "input": [{"type":"text","text":title_prompt,"text_elements":[]}],
                                "cwd": null,
                                "approvalPolicy": "never",
                                "permissions": ":read-only",
                                "runtimeWorkspaceRoots": [],
                                "model": null,
                                "effort": "low",
                                "serviceTier": null,
                                "outputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "title": {"type":"string","minLength":1,"maxLength":36}
                                    },
                                    "required": ["title"],
                                    "additionalProperties": false
                                },
                                "collaborationMode": null
                            }
                        }),
                    );
                } else {
                    pending_title = title_fallback.clone();
                }
            }
            if message.get("id") == Some(&json!(TITLE_TURN_REQUEST_ID))
                && message.get("error").is_some()
            {
                pending_title = title_fallback.clone();
                if let Some(id) = title_thread_id.as_deref() {
                    let _ = send(
                        &stdin_reader,
                        &json!({
                            "method": "thread/unsubscribe",
                            "id": TITLE_UNSUBSCRIBE_REQUEST_ID,
                            "params": {"threadId": id}
                        }),
                    );
                }
            }
            let is_title_message = title_thread_id.as_deref().is_some_and(|id| {
                message.pointer("/params/threadId").and_then(Value::as_str) == Some(id)
                    || message.pointer("/params/thread/id").and_then(Value::as_str) == Some(id)
            });
            if is_title_message && message.get("method") == Some(&json!("item/agentMessage/delta"))
            {
                if let Some(delta) = message.pointer("/params/delta").and_then(Value::as_str) {
                    title_output.push_str(delta);
                }
            }
            if is_title_message && message.get("method") == Some(&json!("item/completed")) {
                if let Some(text) = message.pointer("/params/item/text").and_then(Value::as_str) {
                    title_output = text.to_string();
                }
            }
            if is_title_message && message.get("method") == Some(&json!("turn/completed")) {
                pending_title =
                    parse_generated_title(&title_output).or_else(|| title_fallback.clone());
                if let Some(id) = title_thread_id.as_deref() {
                    let _ = send(
                        &stdin_reader,
                        &json!({
                            "method": "thread/unsubscribe",
                            "id": TITLE_UNSUBSCRIBE_REQUEST_ID,
                            "params": {"threadId": id}
                        }),
                    );
                }
            }
            if !title_name_sent {
                if let (Some(title), Some(id)) = (
                    pending_title.as_deref(),
                    thread_id.lock().expect("thread id lock").as_deref(),
                ) {
                    let _ = send(
                        &stdin_reader,
                        &json!({
                            "method": "thread/name/set",
                            "id": TITLE_NAME_REQUEST_ID,
                            "params": {"threadId": id, "name": title}
                        }),
                    );
                    title_name_sent = true;
                }
            }
            if !is_title_message {
                let incoming_turn = message
                    .pointer("/params/turnId")
                    .or_else(|| message.pointer("/params/turn/id"))
                    .and_then(Value::as_str);
                if incoming_turn.is_some_and(|id| retired_turns.contains(id)) {
                    continue;
                }
                if response_id == Some(pending_turn_request.load(Ordering::SeqCst)) {
                    if let Some(id) = message.pointer("/result/turn/id").and_then(Value::as_str) {
                        *turn_id.lock().expect("turn id lock") = Some(id.to_string());
                        starting.store(false, Ordering::SeqCst);
                    }
                }
            }
            if !is_title_message && message.get("method") == Some(&json!("turn/started")) {
                if let Some(id) = message.pointer("/params/turn/id").and_then(Value::as_str) {
                    *turn_id.lock().expect("turn id lock") = Some(id.to_string());
                }
            }
            let is_title_request = [
                TITLE_THREAD_REQUEST_ID,
                TITLE_TURN_REQUEST_ID,
                TITLE_NAME_REQUEST_ID,
                TITLE_UNSUBSCRIBE_REQUEST_ID,
            ]
            .iter()
            .any(|id| message.get("id") == Some(&json!(id)));
            if is_title_message || is_title_request {
                continue;
            }
            if !is_title_message && message.get("method") == Some(&json!("turn/completed")) {
                starting.store(false, Ordering::SeqCst);
                if let Ok(mut active) = turn_id.lock() {
                    if let Some(id) = active.take() {
                        retired_turns.insert(id);
                    }
                }
                activity.finish();
            }
            // Release only errors for startup/turn requests, never unrelated RPC
            // errors while a turn might still be running or awaiting approval.
            if message.get("error").is_some()
                && (message.get("id") == Some(&json!(0))
                    || message.get("id") == Some(&json!(1))
                    || message.get("id")
                        == Some(&json!(pending_turn_request.load(Ordering::SeqCst))))
            {
                activity.finish();
            }
            if message.get("method") == Some(&json!("turn/started"))
                || message.get("error").is_some()
            {
                starting.store(false, Ordering::SeqCst);
            }
            if let Some(response) = unsupported_request_response(&message) {
                let _ = send(&stdin_reader, &response);
                continue;
            }
            if let Ok(mut pending) = approvals.lock() {
                if message.get("method") == Some(&json!("turn/completed"))
                    || message.get("error").is_some()
                {
                    pending.clear();
                }
                pending.insert(&message);
            }
            let _ = event_app.emit(&event_name, &message);
            let _ = event_app.emit(
                "codex-event",
                json!({"runId":generic_run_id,"message":message}),
            );
        }
        if let Ok(mut pending) = approvals.lock() {
            pending.clear();
        }
        starting.store(false, Ordering::SeqCst);
        activity.finish();
        let _ = event_app.emit(
            "codex-event",
            json!({"runId": generic_run_id, "message": {"method": "runtime/exited"}}),
        );
    });
    let error_app = app.clone();
    let error_run_id = run_id.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let _ = error_app.emit(
                "codex-event",
                json!({
                    "runId": error_run_id,
                    "message": {"method":"runtime/stderr","params":{"message":line}}
                }),
            );
        }
    });
    Ok(StartRunResponse { run_id, prompt })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_restrictions_use_the_runtime_config_and_fail_closed() {
        let config = json!({"config": {"mcp_servers": {"allowed": {}, "inherited": {}}}});
        let overrides = runtime_mcp_overrides(Some(&config), &["allowed".into()]).unwrap();
        assert_eq!(overrides["mcp_servers"]["allowed"]["enabled"], true);
        assert_eq!(overrides["mcp_servers"]["inherited"]["enabled"], false);
        assert!(runtime_mcp_overrides(None, &[]).is_err());
        assert!(runtime_mcp_overrides(Some(&json!({})), &[]).is_err());
    }

    #[test]
    fn unsupported_server_requests_receive_an_error_instead_of_hanging() {
        assert!(unsupported_request_response(
            &json!({"id": 1, "method": "item/commandExecution/requestApproval"})
        )
        .is_none());
        assert!(unsupported_request_response(&json!({"id": 1, "result": {}})).is_none());
        assert!(unsupported_request_response(&json!({"method": "turn/started"})).is_none());
        let response = unsupported_request_response(
            &json!({"id": "request", "method": "item/tool/requestUserInput"}),
        )
        .unwrap();
        assert_eq!(response["id"], "request");
        assert_eq!(response["error"]["code"], -32601);
    }

    #[test]
    fn uses_a_neutral_codex_directory_for_projectless_runs() {
        assert_eq!(
            projectless_cwd_from_documents(Path::new("/Users/test/Documents")),
            Path::new("/Users/test/Documents/Codex/Latch Bar")
        );
    }

    #[test]
    fn parses_and_normalizes_generated_titles() {
        assert_eq!(
            parse_generated_title(r#"{"title":"  Fix conversation titles!  "}"#).as_deref(),
            Some("Fix conversation titles")
        );
    }

    #[test]
    fn falls_back_to_the_agent_task_name() {
        assert_eq!(
            fallback_title("Task: Improve writing\nSelected content: hello").as_deref(),
            Some("Improve writing")
        );
    }
}

#[tauri::command]
pub fn continue_codex_run(
    app: AppHandle,
    manager: State<RuntimeManager>,
    run_id: String,
    prompt: String,
) -> Result<(), String> {
    continue_run(
        RuntimeEvents::tauri(app),
        &manager,
        run_id,
        prompt,
        std::time::Duration::from_secs(30),
    )
}
fn continue_run(
    events: RuntimeEvents,
    manager: &RuntimeManager,
    run_id: String,
    prompt: String,
    timeout: std::time::Duration,
) -> Result<(), String> {
    let processes = manager
        .0
        .lock()
        .map_err(|_| "Runtime manager is unavailable")?;
    let process = processes.get(&run_id).ok_or("Run not found")?;
    let thread_id = process
        .thread_id
        .lock()
        .map_err(|_| "Thread state unavailable")?
        .clone()
        .ok_or("Thread has not started")?;
    let request_id = process.next_request_id.fetch_add(1, Ordering::SeqCst);
    let mut active_turn = process
        .turn_id
        .lock()
        .map_err(|_| "Turn state unavailable")?;
    process.activity.resume(&manager.1)?;
    process
        .pending_turn_request
        .store(request_id, Ordering::SeqCst);
    *active_turn = None;
    drop(active_turn);
    process.starting.store(true, Ordering::SeqCst);
    process.deadline(events, run_id.clone(), request_id, timeout);
    let result = send(
        &process.stdin,
        &json!({
            "method":"turn/start",
            "id":request_id,
            "params":{
                "threadId":thread_id,
                "input":[{"type":"text","text":prompt,"text_elements":[]}],
                "effort":process.effort
            }
        }),
    );
    if result.is_err() {
        process.starting.store(false, Ordering::SeqCst);
        process.activity.finish();
    }
    result
}

#[tauri::command]
pub fn respond_to_approval(
    manager: State<RuntimeManager>,
    run_id: String,
    request_id: Value,
    response: Value,
) -> Result<(), String> {
    answer_approval(&manager, &run_id, &request_id, &response)
}
fn answer_approval(
    manager: &RuntimeManager,
    run_id: &str,
    request_id: &Value,
    response: &Value,
) -> Result<(), String> {
    let processes = manager
        .0
        .lock()
        .map_err(|_| "Runtime manager is unavailable")?;
    let process = processes.get(run_id).ok_or("Run not found")?;
    let mut pending = process
        .approvals
        .lock()
        .map_err(|_| "Approval state unavailable")?;
    pending.validate(request_id, response)?;
    send(&process.stdin, &json!({"id":request_id,"result":response}))?;
    pending.remove(request_id);
    Ok(())
}

#[tauri::command]
pub fn interrupt_codex_run(manager: State<RuntimeManager>, run_id: String) -> Result<(), String> {
    interrupt_run(&manager, &run_id)
}
fn interrupt_run(manager: &RuntimeManager, run_id: &str) -> Result<(), String> {
    let processes = manager
        .0
        .lock()
        .map_err(|_| "Runtime manager is unavailable")?;
    let process = processes.get(run_id).ok_or("Run not found")?;
    let thread_id = process
        .thread_id
        .lock()
        .map_err(|_| "Thread state unavailable")?
        .clone()
        .ok_or("Thread has not started")?;
    let turn_id = process
        .turn_id
        .lock()
        .map_err(|_| "Turn state unavailable")?
        .clone()
        .ok_or("Turn has not started")?;
    send(
        &process.stdin,
        &json!({"method":"turn/interrupt","id":process.next_request_id.fetch_add(1, Ordering::SeqCst),"params":{"threadId":thread_id,"turnId":turn_id}}),
    )
}

#[tauri::command]
pub fn stop_codex_run(manager: State<RuntimeManager>, run_id: String) -> Result<(), String> {
    let process = manager
        .0
        .lock()
        .map_err(|_| "Runtime manager is unavailable")?
        .remove(&run_id)
        .ok_or("Run not found")?;
    drop(process);
    Ok(())
}

impl RuntimeProcess {
    fn deadline(
        &self,
        events: RuntimeEvents,
        run_id: String,
        request_id: u64,
        timeout: std::time::Duration,
    ) {
        let pending = self.pending_turn_request.clone();
        let starting = self.starting.clone();
        let child = self.child.clone();
        let activity = self.activity.clone();
        let approvals = self.approvals.clone();
        std::thread::spawn(move || {
            let mut remaining = timeout;
            while pending.load(Ordering::SeqCst) == request_id && starting.load(Ordering::SeqCst) {
                let waiting_for_user = approvals
                    .lock()
                    .map(|pending| !pending.is_empty())
                    .unwrap_or(false);
                let before = std::time::Instant::now();
                std::thread::sleep(remaining.min(std::time::Duration::from_millis(25)));
                if !waiting_for_user {
                    remaining = remaining.saturating_sub(before.elapsed());
                }
                if remaining.is_zero() {
                    break;
                }
            }
            if remaining.is_zero()
                && pending.load(Ordering::SeqCst) == request_id
                && starting.swap(false, Ordering::SeqCst)
            {
                let _ = events.emit("codex-event", json!({"runId":run_id,"message":{"error":{"message":"Codex did not start the turn within 30 seconds"}}}));
                if let Ok(mut child) = child.lock() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                activity.finish();
            }
        });
    }
}

impl Drop for RuntimeProcess {
    fn drop(&mut self) {
        self.starting.store(false, Ordering::SeqCst);
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.activity.finish();
    }
}

impl RuntimeManager {
    pub fn shutdown(&self) {
        if let Ok(mut processes) = self.0.lock() {
            self.2.fetch_add(1, Ordering::SeqCst);
            processes.clear();
        }
    }
}

#[cfg(test)]
#[path = "runtime_protocol_tests.rs"]
mod protocol_tests;
