use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    available: bool,
    version: String,
    codex_home: String,
    mode: String,
    path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentSnapshot {
    codex_home: String,
    config_path: String,
    user_agent: String,
    models: Vec<ModelSummary>,
    effective_config: EffectiveConfigSummary,
    account: AccountSummary,
    profiles: Vec<String>,
    mcp_servers: Vec<McpSummary>,
    skills: Vec<SkillSummary>,
    permission_profiles: Vec<PermissionProfileSummary>,
    requirements: RequirementsSummary,
    provider_capabilities: ProviderCapabilitiesSummary,
    experimental_features: Vec<ExperimentalFeatureSummary>,
    workspaces: Vec<WorkspaceSummary>,
    errors: Vec<String>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModelSummary {
    id: String,
    model: String,
    display_name: String,
    description: String,
    hidden: bool,
    is_default: bool,
    supported_reasoning_efforts: Vec<ReasoningEffortSummary>,
    default_reasoning_effort: Option<String>,
    service_tiers: Vec<ServiceTierSummary>,
    default_service_tier: Option<String>,
    input_modalities: Vec<String>,
    supports_personality: bool,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningEffortSummary {
    id: String,
    description: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ServiceTierSummary {
    id: String,
    name: String,
    description: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveConfigSummary {
    model: Option<String>,
    model_provider: Option<String>,
    reasoning_effort: Option<String>,
    service_tier: Option<String>,
    approval_policy: Option<String>,
    sandbox_mode: Option<String>,
    permission_profile: Option<String>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AccountSummary {
    signed_in: bool,
    account_type: Option<String>,
    plan_type: Option<String>,
    requires_openai_auth: bool,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PermissionProfileSummary {
    id: String,
    description: Option<String>,
    allowed: bool,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RequirementsSummary {
    allowed_approval_policies: Option<Vec<String>>,
    allowed_sandbox_modes: Option<Vec<String>>,
    allowed_permission_profiles: Option<BTreeMap<String, bool>>,
    default_permissions: Option<String>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCapabilitiesSummary {
    namespace_tools: bool,
    image_generation: bool,
    web_search: bool,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExperimentalFeatureSummary {
    name: String,
    display_name: Option<String>,
    description: Option<String>,
    stage: String,
    enabled: bool,
    default_enabled: bool,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSummary {
    id: String,
    name: String,
    path: String,
    branch: Option<String>,
    last_used_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSummary {
    id: String,
    name: String,
    transport: String,
    enabled: bool,
    authentication: String,
    source: String,
    health: String,
    detail: String,
    configurable: bool,
    config_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSummary {
    id: String,
    legacy_id: String,
    plugin_id: Option<String>,
    name: String,
    description: String,
    source: String,
    path: String,
    enabled: bool,
    compatible: bool,
    validation_errors: Vec<String>,
}

fn codex_home() -> PathBuf {
    env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".codex")))
        .unwrap_or_else(|| PathBuf::from(".codex"))
}

pub(crate) fn expand_user_path(value: String) -> String {
    if let Some(relative) = value.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(relative).to_string_lossy().into_owned();
        }
    }
    value
}

fn executable_names() -> &'static [&'static str] {
    if cfg!(windows) {
        &["codex.exe", "codex.cmd", "codex"]
    } else {
        &["codex"]
    }
}

fn command_directories() -> Vec<PathBuf> {
    let path = env::var_os("PATH")
        .map(|value| env::split_paths(&value).collect())
        .unwrap_or_default();
    command_directories_for(path, dirs::home_dir().as_deref())
}

// Apps opened from Finder inherit launchd's minimal PATH, not the login shell's.
// Include the usual user-level install locations so a terminal-only PATH entry
// is not required to find Codex.
fn command_directories_for(path: Vec<PathBuf>, home: Option<&Path>) -> Vec<PathBuf> {
    let mut directories = path;
    if let Some(home) = home {
        directories.extend([
            home.join(".npm-global/bin"),
            home.join(".local/bin"),
            home.join(".cargo/bin"),
            home.join(".volta/bin"),
            home.join(".bun/bin"),
            home.join(".asdf/shims"),
            home.join(".local/share/mise/shims"),
            home.join("Library/pnpm"),
        ]);
        if let Ok(versions) = fs::read_dir(home.join(".nvm/versions/node")) {
            directories.extend(versions.flatten().map(|entry| entry.path().join("bin")));
        }
    }
    if cfg!(target_os = "macos") {
        directories.extend([
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
        ]);
    }
    let mut seen = HashSet::new();
    directories.retain(|directory| seen.insert(directory.clone()));
    directories
}

// The Codex and ChatGPT desktop apps ship their own Codex CLI. Users who installed
// only one of these apps have no `codex` on any PATH.
fn bundled_codex_executables(home: Option<&Path>) -> Vec<PathBuf> {
    if !cfg!(target_os = "macos") {
        return Vec::new();
    }
    let mut roots = vec![PathBuf::from("/Applications")];
    if let Some(home) = home {
        roots.push(home.join("Applications"));
    }
    roots
        .iter()
        .flat_map(|root| {
            [
                root.join("Codex.app/Contents/Resources/codex-cli/bin/codex"),
                root.join("ChatGPT.app/Contents/Resources/codex"),
            ]
        })
        .collect()
}

fn codex_candidates(directories: &[PathBuf], home: Option<&Path>) -> Vec<PathBuf> {
    let mut candidates = directories
        .iter()
        .flat_map(|directory| {
            executable_names()
                .iter()
                .map(move |name| directory.join(name))
        })
        .chain(bundled_codex_executables(home))
        .filter(|path| path.is_file())
        .collect::<Vec<_>>();
    candidates.sort();
    candidates.dedup();
    candidates
}

pub(crate) fn parse_codex_version(stdout: &[u8]) -> Vec<u64> {
    String::from_utf8_lossy(stdout)
        .split_whitespace()
        .last()
        .unwrap_or_default()
        .split(['.', '-'])
        .map_while(|part| part.parse::<u64>().ok())
        .collect()
}

pub(crate) fn command_for_executable(executable: &Path, directories: &[PathBuf]) -> Command {
    let mut command = Command::new(executable);
    // npm's Codex wrapper uses /usr/bin/env node. Use the sibling Node from
    // this installation for both version probes and app-server launches.
    let parent = executable
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty());
    let paths = parent.into_iter().map(Path::to_path_buf).chain(
        directories
            .iter()
            .filter(|directory| Some(directory.as_path()) != parent)
            .cloned(),
    );
    if let Ok(path) = env::join_paths(paths) {
        command.env("PATH", path);
    }
    command
}

#[cfg(test)]
fn newest_codex_executable(candidates: Vec<PathBuf>, directories: &[PathBuf]) -> Option<PathBuf> {
    crate::discovery::newest(candidates, directories).map(|item| item.path)
}
fn resolve_codex(force: bool) -> Result<(crate::discovery::Executable, Vec<PathBuf>), String> {
    let directories = command_directories();
    let executable = crate::discovery::resolve(codex_candidates(&directories, dirs::home_dir().as_deref()), &directories, env::var_os("CODEX_BIN").map(PathBuf::from), force)?;
    Ok((executable, directories))
}
pub(crate) fn codex_command() -> Result<Command, String> {
    let (executable, directories) = resolve_codex(false)?;
    Ok(command_for_executable(&executable.path, &directories))
}

pub(crate) fn codex_spawn_error(error: std::io::Error) -> String {
    crate::discovery::invalidate();
    if error.kind() == std::io::ErrorKind::NotFound {
        return "Codex was not found. Install the Codex app or the Codex CLI, then check Settings → Codex.".into();
    }
    format!("Could not start Codex app-server: {error}")
}

pub(crate) fn codex_app_server_command(profile: Option<&str>) -> Result<Command, String> {
    let mut command = codex_command()?;
    if let Some(profile) = profile.filter(|profile| !profile.is_empty() && *profile != "default") {
        command.arg("--profile").arg(profile);
    }
    command.arg("app-server");
    Ok(command)
}

#[tauri::command]
pub async fn codex_status(force_refresh: Option<bool>) -> Result<RuntimeStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (executable, _) = resolve_codex(force_refresh.unwrap_or(false))?;
        Ok(RuntimeStatus { available: true, version: executable.version.trim_start_matches("codex-cli ").to_string(), codex_home: codex_home().to_string_lossy().into_owned(), mode: "native".into(), path: Some(executable.path.to_string_lossy().into_owned()) })
    }).await.map_err(|error| error.to_string())?
}

pub(crate) fn mcp_config_overrides(
    configured_servers: &[String],
    enabled_servers: &[String],
) -> Value {
    let enabled = enabled_servers.iter().collect::<HashSet<_>>();
    let overrides = configured_servers
        .iter()
        .map(|id| {
            let is_enabled = enabled.contains(id);
            (id.clone(), json!({ "enabled": is_enabled }))
        })
        .collect::<serde_json::Map<_, _>>();
    json!({ "mcp_servers": overrides })
}

fn string(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_string)
}

fn string_list(value: Option<&Value>) -> Option<Vec<String>> {
    value.and_then(Value::as_array).map(|items| {
        items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect()
    })
}

fn display_name(id: &str) -> String {
    id.split(['-', '_'])
        .map(|part| {
            let mut chars = part.chars();
            chars
                .next()
                .map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn slug(value: &str) -> String {
    let mut result = String::new();
    let mut pending_dash = false;
    for character in value.chars().flat_map(char::to_lowercase) {
        if character.is_alphanumeric() {
            if pending_dash && !result.is_empty() {
                result.push('-');
            }
            result.push(character);
            pending_dash = false;
        } else {
            pending_dash = true;
        }
    }
    result
}

fn query(
    client: &mut crate::app_server::AppServerClient,
    method: &str,
    params: Value,
    errors: &mut Vec<String>,
) -> Option<Value> {
    match client.request(method, params) {
        Ok(result) => Some(result),
        Err(error) => {
            errors.push(error);
            None
        }
    }
}

fn paginated(
    client: &mut crate::app_server::AppServerClient,
    method: &str,
    params: Value,
    max_pages: usize,
    errors: &mut Vec<String>,
) -> Vec<Value> {
    let mut data = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..max_pages {
        let mut page_params = params.clone();
        if let (Some(cursor), Some(object)) = (cursor.as_ref(), page_params.as_object_mut()) {
            object.insert("cursor".into(), json!(cursor));
        }
        let Some(page) = query(client, method, page_params, errors) else {
            break;
        };
        if let Some(items) = page.get("data").and_then(Value::as_array) {
            data.extend(items.iter().cloned());
        }
        cursor = string(page.get("nextCursor"));
        if cursor.is_none() {
            break;
        }
    }
    data
}

fn parse_models(items: Vec<Value>) -> Vec<ModelSummary> {
    items
        .into_iter()
        .filter_map(|item| {
            let model = item.get("model")?.as_str()?.to_string();
            let supported_reasoning_efforts = item
                .get("supportedReasoningEfforts")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|effort| {
                    Some(ReasoningEffortSummary {
                        id: effort.get("reasoningEffort")?.as_str()?.to_string(),
                        description: effort
                            .get("description")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                    })
                })
                .collect();
            let service_tiers = item
                .get("serviceTiers")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|tier| {
                    Some(ServiceTierSummary {
                        id: tier.get("id")?.as_str()?.to_string(),
                        name: tier
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        description: tier
                            .get("description")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                    })
                })
                .collect();
            Some(ModelSummary {
                id: item
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or(&model)
                    .to_string(),
                display_name: item
                    .get("displayName")
                    .and_then(Value::as_str)
                    .unwrap_or(&model)
                    .to_string(),
                description: item
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                hidden: item.get("hidden").and_then(Value::as_bool).unwrap_or(false),
                is_default: item
                    .get("isDefault")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                default_reasoning_effort: string(item.get("defaultReasoningEffort")),
                default_service_tier: string(item.get("defaultServiceTier")),
                input_modalities: item
                    .get("inputModalities")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect(),
                supports_personality: item
                    .get("supportsPersonality")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                supported_reasoning_efforts,
                service_tiers,
                model,
            })
        })
        .collect()
}

fn parse_effective_config(response: Option<&Value>) -> EffectiveConfigSummary {
    let config = response.and_then(|response| response.get("config"));
    EffectiveConfigSummary {
        model: string(config.and_then(|value| value.get("model"))),
        model_provider: string(config.and_then(|value| value.get("model_provider"))),
        reasoning_effort: string(config.and_then(|value| value.get("model_reasoning_effort"))),
        service_tier: string(config.and_then(|value| value.get("service_tier"))),
        approval_policy: string(config.and_then(|value| value.get("approval_policy"))),
        sandbox_mode: string(config.and_then(|value| value.get("sandbox_mode"))),
        permission_profile: string(config.and_then(|value| value.get("default_permissions"))),
    }
}

fn effective_user_config_path(response: Option<&Value>, home: &Path) -> String {
    response
        .and_then(|response| response.get("layers"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|layer| layer.get("name"))
        .find(|source| {
            source.get("type").and_then(Value::as_str) == Some("user")
                && source.get("profile").is_none_or(Value::is_null)
        })
        .and_then(|source| source.get("file"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| home.join("config.toml").to_string_lossy().into_owned())
}

fn parse_account(response: Option<&Value>) -> AccountSummary {
    let account = response.and_then(|value| value.get("account"));
    AccountSummary {
        signed_in: account.is_some_and(|value| !value.is_null()),
        account_type: string(account.and_then(|value| value.get("type"))),
        plan_type: string(account.and_then(|value| value.get("planType"))),
        requires_openai_auth: response
            .and_then(|value| value.get("requiresOpenaiAuth"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }
}

fn mcp_origin(config_response: Option<&Value>, id: &str, fallback_path: &str) -> (String, String) {
    let root = format!("mcp_servers.{id}");
    let prefix = format!("mcp_servers.{id}.");
    let source = config_response
        .and_then(|response| response.get("origins"))
        .and_then(Value::as_object)
        .and_then(|origins| {
            origins
                .iter()
                .find(|(key, _)| key.as_str() == root || key.starts_with(&prefix))
        })
        .and_then(|(_, metadata)| metadata.get("name"));
    let kind = source
        .and_then(|source| source.get("type"))
        .and_then(Value::as_str)
        .unwrap_or("effective");
    let label = match kind {
        "user"
            if source
                .and_then(|value| value.get("profile"))
                .is_some_and(|value| !value.is_null()) =>
        {
            "profile"
        }
        "user" => "user",
        "project" => "project",
        "system" => "system",
        "enterpriseManaged" => "enterprise",
        "mdm" | "legacyManagedConfigTomlFromFile" | "legacyManagedConfigTomlFromMdm" => "managed",
        "sessionFlags" => "session",
        _ => "effective",
    };
    let path = source
        .and_then(|source| {
            source
                .get("file")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| {
                    source
                        .get("dotCodexFolder")
                        .and_then(Value::as_str)
                        .map(|folder| {
                            Path::new(folder)
                                .join("config.toml")
                                .to_string_lossy()
                                .into_owned()
                        })
                })
        })
        .unwrap_or_else(|| fallback_path.to_string());
    (label.into(), path)
}

fn parse_mcps(
    config_response: Option<&Value>,
    statuses: Vec<Value>,
    config_path: &str,
) -> Vec<McpSummary> {
    let mut servers = BTreeMap::<String, McpSummary>::new();
    if let Some(configured) = config_response
        .and_then(|value| value.get("config"))
        .and_then(|value| value.get("mcp_servers"))
        .and_then(Value::as_object)
    {
        for (id, value) in configured {
            let (source, origin_path) = mcp_origin(config_response, id, config_path);
            let enabled = value
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let transport = if value.get("url").is_some() {
                "http"
            } else {
                "stdio"
            };
            let authentication = if value.get("bearer_token_env_var").is_some() {
                "bearer"
            } else if value.get("env").is_some() || value.get("env_vars").is_some() {
                "environment"
            } else {
                "unknown"
            };
            servers.insert(
                id.clone(),
                McpSummary {
                    id: id.clone(),
                    name: display_name(id),
                    transport: transport.into(),
                    enabled,
                    authentication: authentication.into(),
                    source,
                    health: if enabled { "unknown" } else { "disabled" }.into(),
                    detail: if enabled {
                        "Waiting for Codex status"
                    } else {
                        "Disabled in Codex"
                    }
                    .into(),
                    configurable: true,
                    config_path: origin_path,
                },
            );
        }
    }

    for status in statuses {
        let Some(id) = status.get("name").and_then(Value::as_str) else {
            continue;
        };
        let tool_count = status
            .get("tools")
            .and_then(Value::as_object)
            .map(|tools| tools.len())
            .unwrap_or(0);
        let resource_count = status
            .get("resources")
            .and_then(Value::as_array)
            .map(|resources| resources.len())
            .unwrap_or(0);
        let auth_status = status
            .get("authStatus")
            .and_then(Value::as_str)
            .unwrap_or("unsupported");
        let entry = servers.entry(id.to_string()).or_insert_with(|| McpSummary {
            id: id.to_string(),
            name: display_name(id),
            transport: "managed".into(),
            enabled: true,
            authentication: "unknown".into(),
            source: "managed".into(),
            health: "unknown".into(),
            detail: String::new(),
            configurable: false,
            config_path: config_path.into(),
        });
        entry.authentication = match auth_status {
            "oAuth" | "notLoggedIn" => "oauth",
            "bearerToken" => "bearer",
            _ => "none",
        }
        .into();
        if entry.enabled {
            entry.health = if auth_status == "notLoggedIn" {
                "error"
            } else {
                "connected"
            }
            .into();
        }
        entry.detail = match (tool_count, resource_count) {
            (tools, 0) => format!("{tools} tools"),
            (tools, resources) => format!("{tools} tools · {resources} resources"),
        };
    }
    servers.into_values().collect()
}

fn parse_skills(response: Option<&Value>) -> Vec<SkillSummary> {
    let mut errors = Vec::<(String, String)>::new();
    let mut skills = BTreeMap::<String, SkillSummary>::new();
    for entry in response
        .and_then(|value| value.get("data"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        for error in entry
            .get("errors")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let (Some(path), Some(message)) = (
                error.get("path").and_then(Value::as_str),
                error.get("message").and_then(Value::as_str),
            ) {
                errors.push((path.into(), message.into()));
            }
        }
        for skill in entry
            .get("skills")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(name) = skill.get("name").and_then(Value::as_str) else {
                continue;
            };
            let path = skill
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let path = fs::canonicalize(&path).map(|value| value.to_string_lossy().into_owned()).unwrap_or(path);
            let source = skill.get("scope").and_then(Value::as_str).unwrap_or("user").to_string();
            let plugin_id = skill.get("pluginId").and_then(Value::as_str).map(str::to_string);
            let id = format!("skill:v1:{}", json!([source, path, plugin_id]));
            let validation_errors = errors
                .iter()
                .filter(|(error_path, _)| {
                    path.starts_with(error_path) || error_path.starts_with(&path)
                })
                .map(|(_, message)| message.clone())
                .collect::<Vec<_>>();
            skills.insert(
                id.clone(),
                SkillSummary {
                    id,
                    legacy_id: slug(name),
                    plugin_id,
                    name: name.into(),
                    description: skill
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .into(),
                    source,
                    path: path.clone(),
                    enabled: skill
                        .get("enabled")
                        .and_then(Value::as_bool)
                        .unwrap_or(true),
                    compatible: !path.is_empty() && validation_errors.is_empty(),
                    validation_errors,
                },
            );
        }
    }
    skills.into_values().collect()
}

fn parse_permissions(items: Vec<Value>) -> Vec<PermissionProfileSummary> {
    items
        .into_iter()
        .filter_map(|item| {
            Some(PermissionProfileSummary {
                id: item.get("id")?.as_str()?.into(),
                description: string(item.get("description")),
                allowed: item.get("allowed").and_then(Value::as_bool).unwrap_or(true),
            })
        })
        .collect()
}

fn parse_requirements(response: Option<&Value>) -> RequirementsSummary {
    let requirements = response.and_then(|value| value.get("requirements"));
    RequirementsSummary {
        allowed_approval_policies: string_list(
            requirements.and_then(|value| value.get("allowedApprovalPolicies")),
        ),
        allowed_sandbox_modes: string_list(
            requirements.and_then(|value| value.get("allowedSandboxModes")),
        ),
        allowed_permission_profiles: requirements
            .and_then(|value| value.get("allowedPermissionProfiles"))
            .and_then(Value::as_object)
            .map(|profiles| {
                profiles
                    .iter()
                    .filter_map(|(id, allowed)| Some((id.clone(), allowed.as_bool()?)))
                    .collect()
            }),
        default_permissions: string(requirements.and_then(|value| value.get("defaultPermissions"))),
    }
}

fn parse_provider_capabilities(response: Option<&Value>) -> ProviderCapabilitiesSummary {
    ProviderCapabilitiesSummary {
        namespace_tools: response
            .and_then(|value| value.get("namespaceTools"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        image_generation: response
            .and_then(|value| value.get("imageGeneration"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        web_search: response
            .and_then(|value| value.get("webSearch"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }
}

fn parse_experimental_features(items: Vec<Value>) -> Vec<ExperimentalFeatureSummary> {
    items
        .into_iter()
        .filter_map(|item| {
            Some(ExperimentalFeatureSummary {
                name: item.get("name")?.as_str()?.into(),
                display_name: string(item.get("displayName")),
                description: string(item.get("description")),
                stage: item
                    .get("stage")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .into(),
                enabled: item
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                default_enabled: item
                    .get("defaultEnabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            })
        })
        .collect()
}

fn parse_workspaces(items: Vec<Value>) -> Vec<WorkspaceSummary> {
    let mut by_path = BTreeMap::<String, WorkspaceSummary>::new();
    for item in items {
        let Some(path) = item.get("cwd").and_then(Value::as_str) else {
            continue;
        };
        let workspace_path = Path::new(path);
        let latch_projectless_path = Path::new("Documents").join("Codex").join("Latch Bar");
        if path.is_empty()
            || workspace_path.parent().is_none()
            || workspace_path.ends_with(latch_projectless_path)
        {
            continue;
        }
        let last_used_at = item
            .get("recencyAt")
            .or_else(|| item.get("updatedAt"))
            .and_then(Value::as_i64)
            .unwrap_or_default();
        let replace = by_path
            .get(path)
            .is_none_or(|workspace| last_used_at > workspace.last_used_at);
        if !replace {
            continue;
        }
        let name = Path::new(path)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| path.into());
        by_path.insert(
            path.into(),
            WorkspaceSummary {
                id: path.into(),
                name,
                path: path.into(),
                branch: string(item.get("gitInfo").and_then(|value| value.get("branch"))),
                last_used_at,
            },
        );
    }
    let mut workspaces = by_path.into_values().collect::<Vec<_>>();
    workspaces.sort_by_key(|workspace| std::cmp::Reverse(workspace.last_used_at));
    workspaces
}

fn discover_profiles(home: &Path, config_response: Option<&Value>) -> Vec<String> {
    let mut profiles = BTreeSet::new();
    if let Some(configured) = config_response
        .and_then(|response| response.get("config"))
        .and_then(|config| config.get("profiles"))
        .and_then(Value::as_object)
    {
        profiles.extend(configured.keys().cloned());
    }
    if let Ok(entries) = fs::read_dir(home) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(profile) = name
                .strip_suffix(".config.toml")
                .filter(|name| !name.is_empty())
            {
                profiles.insert(profile.to_string());
            }
        }
    }
    profiles.into_iter().collect()
}

#[tauri::command]
pub async fn scan_codex_environment(
    workspace_path: Option<String>,
    profile: Option<String>,
    force_refresh: Option<bool>,
) -> Result<EnvironmentSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if force_refresh.unwrap_or(false) { resolve_codex(true)?; }
        scan_codex_environment_blocking(workspace_path, profile)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn scan_codex_environment_blocking(
    workspace_path: Option<String>,
    profile: Option<String>,
) -> Result<EnvironmentSnapshot, String> {
    if let Some(path) = workspace_path.as_ref() {
        if !Path::new(&expand_user_path(path.clone())).is_dir() {
            return Err("Workspace must be an existing directory".into());
        }
    }
    let cwd = Some(match workspace_path { Some(path) => fs::canonicalize(expand_user_path(path)).map_err(|error| error.to_string())?.to_string_lossy().into_owned(), None => crate::runtime::projectless_path()?.to_string_lossy().into_owned() });
    let profile = profile
        .as_deref()
        .filter(|profile| !profile.is_empty() && *profile != "default");
    let mut client = crate::app_server::AppServerClient::connect(profile, cwd.as_deref())?;
    let mut errors = Vec::new();
    let home = if client.codex_home.is_empty() {
        codex_home()
    } else {
        PathBuf::from(&client.codex_home)
    };
    let models = parse_models(paginated(
        &mut client,
        "model/list",
        json!({ "limit": 100, "includeHidden": false }),
        20,
        &mut errors,
    ));
    let config_response = query(
        &mut client,
        "config/read",
        json!({ "includeLayers": true, "cwd": cwd }),
        &mut errors,
    );
    let config_path = effective_user_config_path(config_response.as_ref(), &home);
    let skills_response = query(
        &mut client,
        "skills/list",
        json!({ "cwds": cwd.iter().cloned().collect::<Vec<_>>(), "forceReload": false }),
        &mut errors,
    );
    let mcp_statuses = paginated(
        &mut client,
        "mcpServerStatus/list",
        json!({ "limit": 100, "detail": "toolsAndAuthOnly" }),
        20,
        &mut errors,
    );
    let permission_profiles = parse_permissions(paginated(
        &mut client,
        "permissionProfile/list",
        json!({ "limit": 100, "cwd": cwd }),
        20,
        &mut errors,
    ));
    let requirements_response = query(
        &mut client,
        "configRequirements/read",
        Value::Null,
        &mut errors,
    );
    let account_response = query(
        &mut client,
        "account/read",
        json!({ "refreshToken": false }),
        &mut errors,
    );
    let provider_capabilities_response = query(
        &mut client,
        "modelProvider/capabilities/read",
        json!({}),
        &mut errors,
    );
    let experimental_features = parse_experimental_features(paginated(
        &mut client,
        "experimentalFeature/list",
        json!({ "limit": 100 }),
        20,
        &mut errors,
    ));
    let thread_items = paginated(
        &mut client,
        "thread/list",
        json!({
            "limit": 100,
            "sortKey": "recency_at",
            "sortDirection": "desc",
            "archived": false,
            "useStateDbOnly": true
        }),
        20,
        &mut errors,
    );

    Ok(EnvironmentSnapshot {
        codex_home: home.to_string_lossy().into_owned(),
        config_path: config_path.clone(),
        user_agent: client.user_agent.clone(),
        models,
        effective_config: parse_effective_config(config_response.as_ref()),
        account: parse_account(account_response.as_ref()),
        profiles: discover_profiles(&home, config_response.as_ref()),
        mcp_servers: parse_mcps(config_response.as_ref(), mcp_statuses, &config_path),
        skills: parse_skills(skills_response.as_ref()),
        permission_profiles,
        requirements: parse_requirements(requirements_response.as_ref()),
        provider_capabilities: parse_provider_capabilities(provider_capabilities_response.as_ref()),
        experimental_features,
        workspaces: parse_workspaces(thread_items),
        errors,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skills_keep_distinct_paths_and_deduplicate_repeated_listings() {
        let response = json!({"data":[{"skills":[
            {"name":"Review", "path":"/a/SKILL.md", "scope":"user"},
            {"name":"Review", "path":"/b/SKILL.md", "scope":"repo"},
            {"name":"Review", "path":"/a/SKILL.md", "scope":"user"}
        ]}]});
        let skills = parse_skills(Some(&response));
        assert_eq!(skills.len(), 2); assert_ne!(skills[0].id, skills[1].id);
        assert!(skills.iter().all(|skill| skill.id.starts_with("skill:v1:") && skill.legacy_id == "review"));
    }

    #[test]
    fn preserves_inherited_path_precedence_when_adding_install_locations() {
        let preferred = PathBuf::from("/preferred/bin");
        let fallback = PathBuf::from("/another/bin");
        let directories = command_directories_for(
            vec![preferred.clone(), fallback.clone(), preferred.clone()],
            None,
        );
        assert_eq!(&directories[..2], &[preferred.clone(), fallback]);
        assert_eq!(
            directories
                .iter()
                .filter(|path| **path == preferred)
                .count(),
            1
        );
    }

    #[cfg(unix)]
    #[test]
    fn probes_and_launches_nvm_codex_with_its_matching_node() {
        use std::os::unix::fs::PermissionsExt;

        let root = env::temp_dir().join(format!("latch-nvm-runtime-{}", uuid::Uuid::new_v4()));
        let old = root.join(".nvm/versions/node/v16.0.0/bin");
        let new = root.join(".nvm/versions/node/v22.12.0/bin");
        let write_executable = |path: &Path, content: &str| {
            fs::write(path, content).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        };
        for directory in [&old, &new] {
            fs::create_dir_all(directory).unwrap();
            write_executable(&directory.join("codex"), "#!/usr/bin/env node\n");
        }
        // Model a newer wrapper that the older Node cannot execute. The kernel
        // actually resolves /usr/bin/env node through PATH in this test.
        write_executable(&old.join("node"), "#!/bin/sh\nexit 1\n");
        write_executable(&new.join("node"), "#!/bin/sh\nif [ \"$2\" = \"--version\" ]; then echo 'codex-cli 0.160.0'; else echo 'matching Node'; fi\n");
        let directories = vec![old.clone(), new.clone()];
        assert!(!Command::new(new.join("codex"))
            .env("PATH", env::join_paths(&directories).unwrap())
            .arg("--version")
            .status()
            .unwrap()
            .success());

        let resolved =
            newest_codex_executable(vec![old.join("codex"), new.join("codex")], &directories)
                .unwrap();
        assert_eq!(resolved, new.join("codex"));
        let output = command_for_executable(&resolved, &directories)
            .arg("app-server")
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            "matching Node"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn finds_codex_bundled_with_desktop_apps_outside_path() {
        let root = env::temp_dir().join(format!("latch-codex-discovery-{}", uuid::Uuid::new_v4()));
        let bundled = root.join("Applications/Codex.app/Contents/Resources/codex-cli/bin/codex");
        let chatgpt = root.join("Applications/ChatGPT.app/Contents/Resources/codex");
        let nvm = root.join(".nvm/versions/node/v22.12.0/bin/codex");
        for executable in [&bundled, &chatgpt, &nvm] {
            fs::create_dir_all(executable.parent().unwrap()).unwrap();
            fs::write(executable, "").unwrap();
        }

        let directories = command_directories_for(Vec::new(), Some(&root));
        let candidates = codex_candidates(&directories, Some(&root));

        if cfg!(target_os = "macos") {
            assert!(candidates.contains(&bundled));
            assert!(candidates.contains(&chatgpt));
        }
        assert!(candidates.contains(&nvm));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn compares_prerelease_codex_versions_numerically() {
        assert_eq!(
            parse_codex_version(b"codex-cli 0.159.0-alpha.12.1"),
            vec![0, 159, 0]
        );
        assert_eq!(parse_codex_version(b"codex-cli 0.146.1\n"), vec![0, 146, 1]);
        assert!(
            parse_codex_version(b"codex-cli 0.159.0-alpha.12.1")
                > parse_codex_version(b"codex-cli 0.146.1")
        );
    }

    #[test]
    fn parses_model_capabilities_from_app_server_data() {
        let models = parse_models(vec![json!({
            "id": "server-model",
            "model": "server-model",
            "displayName": "Server Model",
            "description": "Discovered at runtime",
            "hidden": false,
            "isDefault": true,
            "supportedReasoningEfforts": [
                { "reasoningEffort": "high", "description": "High" },
                { "reasoningEffort": "ultra", "description": "Ultra" }
            ],
            "defaultReasoningEffort": "high",
            "serviceTiers": [{ "id": "priority", "name": "Priority", "description": "Faster" }],
            "defaultServiceTier": null,
            "inputModalities": ["text", "image"],
            "supportsPersonality": true
        })]);

        assert_eq!(models.len(), 1);
        assert_eq!(models[0].model, "server-model");
        assert_eq!(models[0].supported_reasoning_efforts[1].id, "ultra");
        assert_eq!(models[0].service_tiers[0].id, "priority");
        assert!(models[0].is_default);
    }

    #[test]
    fn builds_mcp_overrides_only_from_discovered_configurable_servers() {
        let overrides = mcp_config_overrides(&["docs".into(), "github".into()], &["docs".into()]);

        assert_eq!(
            overrides.pointer("/mcp_servers/docs/enabled"),
            Some(&json!(true))
        );
        assert_eq!(
            overrides.pointer("/mcp_servers/github/enabled"),
            Some(&json!(false))
        );
        assert!(overrides.pointer("/mcp_servers/runtime-managed").is_none());
    }

    #[test]
    fn reports_mcp_origin_from_app_server_config_metadata() {
        let response = json!({
            "config": {
                "mcp_servers": {
                    "docs": { "url": "https://example.invalid/mcp", "enabled": true }
                }
            },
            "origins": {
                "mcp_servers.docs.url": {
                    "name": { "type": "project", "dotCodexFolder": "/repo/.codex" },
                    "version": "1"
                }
            }
        });
        let servers = parse_mcps(Some(&response), vec![], "/fallback/config.toml");

        assert_eq!(servers[0].source, "project");
        assert_eq!(servers[0].config_path, "/repo/.codex/config.toml");
    }

    #[test]
    fn deduplicates_recent_workspaces_using_the_latest_thread() {
        let workspaces = parse_workspaces(vec![
            json!({ "cwd": "/repo", "updatedAt": 10, "gitInfo": { "branch": "old" } }),
            json!({ "cwd": "/repo", "recencyAt": 20, "gitInfo": { "branch": "main" } }),
            json!({ "cwd": "/other", "updatedAt": 15, "gitInfo": null }),
            json!({ "cwd": "/", "updatedAt": 30, "gitInfo": null }),
            json!({ "cwd": "/Users/test/Documents/Codex/Latch Bar", "updatedAt": 40, "gitInfo": null }),
        ]);

        assert_eq!(workspaces.len(), 2);
        assert_eq!(workspaces[0].path, "/repo");
        assert_eq!(workspaces[0].branch.as_deref(), Some("main"));
        assert_eq!(workspaces[1].path, "/other");
    }

    #[test]
    fn parses_permission_requirements_using_the_app_server_contract() {
        let requirements = parse_requirements(Some(&json!({
            "requirements": {
                "allowedApprovalPolicies": ["on-request"],
                "allowedSandboxModes": ["read-only"],
                "allowedPermissionProfiles": {
                    ":read-only": true,
                    ":danger-full-access": false
                },
                "defaultPermissions": ":read-only"
            }
        })));

        assert_eq!(
            requirements.allowed_approval_policies,
            Some(vec!["on-request".into()])
        );
        assert_eq!(
            requirements
                .allowed_permission_profiles
                .as_ref()
                .and_then(|profiles| profiles.get(":danger-full-access")),
            Some(&false)
        );
        assert_eq!(
            requirements.default_permissions.as_deref(),
            Some(":read-only")
        );
    }

    #[test]
    fn uses_the_user_config_path_reported_by_config_layers() {
        let response = json!({
            "layers": [
                { "name": { "type": "system", "file": "/etc/codex/config.toml" } },
                { "name": { "type": "user", "file": "/custom/codex/config.toml", "profile": null } }
            ]
        });

        assert_eq!(
            effective_user_config_path(Some(&response), Path::new("/fallback")),
            "/custom/codex/config.toml"
        );
    }
}
