use serde::Serialize;
use std::{env, fs, path::{Path, PathBuf}, process::Command};
use walkdir::WalkDir;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    available: bool,
    version: String,
    authenticated: bool,
    codex_home: String,
    mode: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentSnapshot {
    codex_home: String,
    config_path: String,
    mcp_servers: Vec<McpSummary>,
    skills: Vec<SkillSummary>,
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
    config_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSummary {
    id: String,
    name: String,
    description: Option<String>,
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

#[tauri::command]
pub fn codex_status() -> RuntimeStatus {
    let output = Command::new("codex").arg("--version").output();
    let (available, version) = match output {
        Ok(result) if result.status.success() => (true, String::from_utf8_lossy(&result.stdout).trim().replace("codex-cli ", "")),
        _ => (false, "not found".into()),
    };
    let home = codex_home();
    RuntimeStatus {
        available,
        version,
        authenticated: home.join("auth.json").exists(),
        codex_home: home.to_string_lossy().into_owned(),
        mode: "native".into(),
    }
}

fn parse_mcps(config_path: &Path, source: &str) -> Vec<McpSummary> {
    let Ok(raw) = fs::read_to_string(config_path) else { return vec![] };
    let Ok(value) = raw.parse::<toml::Value>() else { return vec![] };
    let Some(servers) = value.get("mcp_servers").and_then(toml::Value::as_table) else { return vec![] };
    servers.iter().map(|(id, server)| {
        let table = server.as_table();
        let transport = if table.and_then(|t| t.get("url")).is_some() { "http" } else { "stdio" };
        let authentication = if table.and_then(|t| t.get("bearer_token_env_var")).is_some() { "bearer" }
            else if table.and_then(|t| t.get("auth")).and_then(toml::Value::as_str) == Some("oauth") { "oauth" }
            else if table.and_then(|t| t.get("env")).is_some() || table.and_then(|t| t.get("env_vars")).is_some() { "environment" }
            else { "none" };
        McpSummary {
            id: id.clone(),
            name: id.split(['-', '_']).map(|part| { let mut chars = part.chars(); chars.next().map(|first| first.to_uppercase().collect::<String>() + chars.as_str()).unwrap_or_default() }).collect::<Vec<_>>().join(" "),
            transport: transport.into(),
            enabled: table.and_then(|t| t.get("enabled")).and_then(toml::Value::as_bool).unwrap_or(true),
            authentication: authentication.into(),
            source: source.into(),
            config_path: config_path.to_string_lossy().into_owned(),
        }
    }).collect()
}

fn skill_from_file(path: &Path, source: &str) -> SkillSummary {
    let raw = fs::read_to_string(path).unwrap_or_default();
    let mut name = path.parent().and_then(Path::file_name).map(|v| v.to_string_lossy().into_owned()).unwrap_or_else(|| "Unnamed skill".into());
    let mut description = None;
    let mut in_frontmatter = false;
    for line in raw.lines().take(24) {
        if line.trim() == "---" { in_frontmatter = !in_frontmatter; continue; }
        if !in_frontmatter { continue; }
        if let Some(value) = line.strip_prefix("name:") { name = value.trim().trim_matches('"').to_string(); }
        if let Some(value) = line.strip_prefix("description:") { description = Some(value.trim().trim_matches('"').to_string()); }
    }
    let validation_errors = if raw.is_empty() { vec!["SKILL.md could not be read".into()] } else { vec![] };
    SkillSummary { id: name.to_lowercase().replace(' ', "-"), name, description, source: source.into(), path: path.to_string_lossy().into_owned(), enabled: true, compatible: validation_errors.is_empty(), validation_errors }
}

#[tauri::command]
pub fn scan_codex_environment(workspace_path: Option<String>) -> EnvironmentSnapshot {
    let home = codex_home();
    let config_path = home.join("config.toml");
    let mut mcps = parse_mcps(&config_path, "global");
    let mut roots: Vec<(PathBuf, &str)> = vec![(home.join("skills"), "global")];
    if let Some(user_home) = dirs::home_dir() { roots.push((user_home.join(".agents/skills"), "global")); }
    if let Some(workspace) = workspace_path {
        let root = PathBuf::from(workspace);
        let project_config = root.join(".codex/config.toml");
        mcps.extend(parse_mcps(&project_config, "project"));
        roots.push((root.join(".agents/skills"), "workspace"));
    }
    let skills = roots.into_iter().flat_map(|(root, source)| {
        if !root.exists() { return Vec::new(); }
        WalkDir::new(root).max_depth(4).follow_links(true).into_iter().filter_map(Result::ok)
            .filter(|entry| entry.file_name() == "SKILL.md")
            .map(|entry| skill_from_file(entry.path(), source)).collect::<Vec<_>>()
    }).collect();
    EnvironmentSnapshot { codex_home: home.to_string_lossy().into_owned(), config_path: config_path.to_string_lossy().into_owned(), mcp_servers: mcps, skills }
}
