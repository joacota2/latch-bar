use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

const TITLE_THREAD_REQUEST_ID: &str = "latch:title:thread";
const TITLE_TURN_REQUEST_ID: &str = "latch:title:turn";
const TITLE_NAME_REQUEST_ID: &str = "latch:title:name";
const TITLE_UNSUBSCRIBE_REQUEST_ID: &str = "latch:title:unsubscribe";
const TITLE_MODEL: &str = "gpt-5.4-mini";

#[derive(Default)]
pub struct RuntimeManager(Mutex<HashMap<String, RuntimeProcess>>);

struct RuntimeProcess {
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
    resolved_mcp_servers: Vec<String>,
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

fn projectless_cwd() -> Result<String, String> {
    let documents = dirs::document_dir()
        .or_else(|| dirs::home_dir().map(|home| home.join("Documents")))
        .ok_or("Could not resolve a Documents directory for projectless runs")?;
    let cwd = projectless_cwd_from_documents(&documents);
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
    title = title
        .trim_end_matches(|character| matches!(character, '.' | '?' | '!'))
        .trim()
        .to_string();
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
pub fn start_codex_run(
    app: AppHandle,
    manager: State<RuntimeManager>,
    agent: AgentRuntimeConfig,
    prompt: String,
    title_source: String,
) -> Result<StartRunResponse, String> {
    let run_id = Uuid::new_v4().to_string();
    let cwd = if agent.workspace_mode == "fixed" {
        agent
            .fixed_workspace_path
            .clone()
            .map(crate::scanner::expand_user_path)
    } else {
        Some(projectless_cwd()?)
    };
    let profile = agent
        .codex_profile
        .as_deref()
        .filter(|profile| !profile.is_empty() && *profile != "default");
    let mut command = crate::scanner::codex_app_server_command(profile);
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
        .map_err(|error| format!("Could not start Codex app-server: {error}"))?;
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
    let process = RuntimeProcess {
        child: child.clone(),
        stdin: stdin.clone(),
        thread_id: thread_id.clone(),
        turn_id: turn_id.clone(),
        next_request_id: AtomicU64::new(3),
        effort: effort.clone(),
    };
    manager
        .0
        .lock()
        .map_err(|_| "Runtime manager is unavailable")?
        .insert(run_id.clone(), process);

    send(
        &stdin,
        &json!({"method":"initialize","id":0,"params":{"clientInfo":{"name":"latch_bar","title":"Latch Bar","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}}}),
    )?;
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
    let config = crate::scanner::mcp_config_overrides(
        &agent.resolved_mcp_servers,
        &agent.enabled_mcp_servers,
    );
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
    thread_params.insert("config".into(), config);
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

    let event_name = format!("codex-event:{run_id}");
    let generic_run_id = run_id.clone();
    let stdin_reader = stdin.clone();
    let prompt_reader = prompt.clone();
    let title_prompt = title_generation_prompt(&title_source);
    let title_fallback = fallback_title(&title_source);
    let enabled_skills = agent.enabled_skills.iter().collect::<HashSet<_>>();
    let skill_inputs = agent
        .resolved_skills
        .iter()
        .filter(|skill| enabled_skills.contains(&skill.id))
        .map(|skill| json!({ "type": "skill", "name": skill.name, "path": skill.path }))
        .collect::<Vec<_>>();
    let event_app = app.clone();
    std::thread::spawn(move || {
        let mut title_thread_id: Option<String> = None;
        let mut title_output = String::new();
        let mut pending_title: Option<String> = None;
        let mut title_name_sent = false;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if message.get("id") == Some(&json!(0)) && message.get("result").is_some() {
                if send(&stdin_reader, &json!({"method":"initialized"})).is_ok() {
                    let _ = send(&stdin_reader, &thread_start_request);
                    let _ = send(&stdin_reader, &title_thread_start_request);
                }
            }
            if message.get("id") == Some(&json!(1)) {
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
            let _ = event_app.emit(&event_name, &message);
            let _ = event_app.emit(
                "codex-event",
                json!({"runId":generic_run_id,"message":message}),
            );
        }
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
    manager: State<RuntimeManager>,
    run_id: String,
    prompt: String,
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
    *process
        .turn_id
        .lock()
        .map_err(|_| "Turn state unavailable")? = None;
    send(
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
    )
}

#[tauri::command]
pub fn respond_to_approval(
    manager: State<RuntimeManager>,
    run_id: String,
    request_id: Value,
    response: Value,
) -> Result<(), String> {
    let processes = manager
        .0
        .lock()
        .map_err(|_| "Runtime manager is unavailable")?;
    let process = processes.get(&run_id).ok_or("Run not found")?;
    send(&process.stdin, &json!({"id":request_id,"result":response}))
}

#[tauri::command]
pub fn interrupt_codex_run(manager: State<RuntimeManager>, run_id: String) -> Result<(), String> {
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
    let turn_id = process
        .turn_id
        .lock()
        .map_err(|_| "Turn state unavailable")?
        .clone()
        .ok_or("Turn has not started")?;
    send(
        &process.stdin,
        &json!({"method":"turn/interrupt","id":99,"params":{"threadId":thread_id,"turnId":turn_id}}),
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
    let result = process
        .child
        .lock()
        .map_err(|_| "Codex process is unavailable")?
        .kill()
        .map_err(|error| error.to_string());
    result
}
