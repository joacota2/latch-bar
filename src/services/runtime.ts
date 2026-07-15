import { invoke } from "@tauri-apps/api/core";
import type { CodexAgent, CodexSkill, McpServer } from "../domain";
import { buildPrompt, type SelectionInput } from "./promptBuilder";

export interface RuntimeStatus {
  available: boolean;
  version: string;
  authenticated: boolean;
  codexHome: string;
  mode: "native" | "preview";
}

export const isTauri = () => "__TAURI_INTERNALS__" in window;

export async function getRuntimeStatus(): Promise<RuntimeStatus> {
  if (isTauri()) return invoke<RuntimeStatus>("codex_status");
  return { available: true, version: "0.133.0", authenticated: true, codexHome: "~/.codex", mode: "preview" };
}

interface NativeEnvironment {
  codexHome: string;
  configPath: string;
  mcpServers: Array<Omit<McpServer, "health" | "detail">>;
  skills: CodexSkill[];
}

export async function scanCodexEnvironment(workspacePath?: string): Promise<{ mcps: McpServer[]; skills: CodexSkill[] } | null> {
  if (!isTauri()) return null;
  const snapshot = await invoke<NativeEnvironment>("scan_codex_environment", { workspacePath });
  return {
    mcps: snapshot.mcpServers.map((server) => ({ ...server, health: "unknown", detail: `${server.source} · ${server.transport.toUpperCase()}` })),
    skills: snapshot.skills,
  };
}

export async function startNativeRun(agent: CodexAgent, input: SelectionInput) {
  const prompt = buildPrompt(agent, input);
  if (!isTauri()) return { runId: `preview-${Date.now()}`, prompt };
  return invoke<{ runId: string; prompt: string }>("start_codex_run", { agent, prompt });
}
