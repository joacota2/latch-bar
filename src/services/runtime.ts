import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { AppSettings, CodexAgent, CodexSkill, McpServer } from "../domain";
import { buildPrompt, type SelectionInput } from "./promptBuilder";

export interface RuntimeStatus {
  available: boolean;
  version: string;
  authenticated: boolean;
  codexHome: string;
  mode: "native" | "unavailable";
}

export interface PlatformStatus {
  platform: string;
  supported: boolean;
  accessibilityTrusted: boolean;
  permissionRequired?: string;
  implementation: string;
  monitorRunning: boolean;
  contextBarReady: boolean;
}

export const isTauri = () => "__TAURI_INTERNALS__" in window;

export async function getRuntimeStatus(): Promise<RuntimeStatus> {
  if (isTauri()) return invoke<RuntimeStatus>("codex_status");
  return { available: false, version: "", authenticated: false, codexHome: "", mode: "unavailable" };
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
  if (!isTauri()) throw new Error("Native Codex runs require the Latch Bar desktop app");
  return invoke<{ runId: string; prompt: string }>("start_codex_run", { agent, prompt });
}

export const continueNativeRun = (runId: string, prompt: string) => invoke<void>("continue_codex_run", { runId, prompt });

export async function getPlatformStatus(): Promise<PlatformStatus> {
  if (!isTauri()) return { platform: "browser", supported: false, accessibilityTrusted: false, implementation: "unavailable", monitorRunning: false, contextBarReady: false };
  return invoke<PlatformStatus>("platform_status", { prompt: false });
}

export async function requestAccessibilityPermission(): Promise<PlatformStatus> {
  if (!isTauri()) return { platform: "browser", supported: false, accessibilityTrusted: false, implementation: "unavailable", monitorRunning: false, contextBarReady: false };
  return invoke<PlatformStatus>("platform_status", { prompt: true });
}

export async function repairAccessibilityPermission(): Promise<PlatformStatus> {
  if (!isTauri()) return { platform: "browser", supported: false, accessibilityTrusted: false, implementation: "unavailable", monitorRunning: false, contextBarReady: false };
  return invoke<PlatformStatus>("repair_accessibility_permission");
}

export async function getStudioShortcutStatus(): Promise<boolean> {
  if (!isTauri()) return false;
  return invoke<boolean>("studio_shortcut_registered");
}

export async function startSelectionMonitor(settings: AppSettings) {
  if (!isTauri()) return;
  return invoke("start_selection_monitor", {
    config: {
      enabled: settings.contextBarEnabled,
      delayMs: settings.selectionDelay,
      minimumCharacters: settings.minimumCharacters,
      excludedApplications: settings.excludedApplications,
    },
  });
}

export const markContextBarReady = () => invoke<void>("context_bar_ready");
export const focusSelectionApplication = (processId: number) => invoke<void>("focus_selection_application", { processId });
export const setOverlayPinned = (pinned: boolean) => invoke<void>("set_overlay_pinned", { pinned });
export const hideContextBar = () => invoke<void>("hide_context_bar");
export const resizeContextBar = (height: number) => invoke<void>("resize_context_bar", { height });
export const setContextBarFocusable = (focusable: boolean) => invoke<void>("set_context_bar_focusable", { focusable });
export const replaceNativeSelection = (text: string) => invoke<{ method: string }>("replace_selection", { text });
export const copyNativeText = (text: string) => invoke<void>("copy_text", { text });
export const openStudio = () => invoke<void>("open_studio");
export const openCodexThread = (threadId: string) => openUrl(`codex://threads/${encodeURIComponent(threadId)}`);
export const interruptNativeRun = (runId: string) => invoke<void>("interrupt_codex_run", { runId });
export const stopNativeRun = (runId: string) => invoke<void>("stop_codex_run", { runId });
export const respondToApproval = (runId: string, requestId: string | number, response: unknown) => invoke<void>("respond_to_approval", { runId, requestId, response });
