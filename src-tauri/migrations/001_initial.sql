CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  icon TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  pinned INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  prompt_template TEXT NOT NULL,
  model TEXT,
  reasoning_effort TEXT,
  service_tier TEXT,
  sandbox TEXT NOT NULL,
  permission_profile TEXT,
  approval_policy TEXT NOT NULL,
  workspace_mode TEXT NOT NULL,
  fixed_workspace_path TEXT,
  codex_profile TEXT,
  context_policy_json TEXT NOT NULL,
  output_policy_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_mcps (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  mcp_server_id TEXT NOT NULL,
  PRIMARY KEY (agent_id, mcp_server_id)
);

CREATE TABLE IF NOT EXISTS agent_skills (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL,
  PRIMARY KEY (agent_id, skill_id)
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  thread_id TEXT,
  turn_id TEXT,
  status TEXT NOT NULL,
  source_application TEXT,
  workspace_path TEXT,
  selected_text_hash TEXT,
  selected_text TEXT,
  final_response TEXT,
  error_message TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);
