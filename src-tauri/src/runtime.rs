use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

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
) -> Result<StartRunResponse, String> {
    let run_id = Uuid::new_v4().to_string();
    let cwd = if agent.workspace_mode == "fixed" {
        agent
            .fixed_workspace_path
            .clone()
            .map(crate::scanner::expand_user_path)
    } else {
        None
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

    let event_name = format!("codex-event:{run_id}");
    let generic_run_id = run_id.clone();
    let stdin_reader = stdin.clone();
    let prompt_reader = prompt.clone();
    let enabled_skills = agent.enabled_skills.iter().collect::<HashSet<_>>();
    let skill_inputs = agent
        .resolved_skills
        .iter()
        .filter(|skill| enabled_skills.contains(&skill.id))
        .map(|skill| json!({ "type": "skill", "name": skill.name, "path": skill.path }))
        .collect::<Vec<_>>();
    let event_app = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if message.get("id") == Some(&json!(0)) && message.get("result").is_some() {
                if send(&stdin_reader, &json!({"method":"initialized"})).is_ok() {
                    let _ = send(&stdin_reader, &thread_start_request);
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
            if message.get("method") == Some(&json!("turn/started")) {
                if let Some(id) = message.pointer("/params/turn/id").and_then(Value::as_str) {
                    *turn_id.lock().expect("turn id lock") = Some(id.to_string());
                }
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
