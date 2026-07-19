import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { AppSettings, CodexAgent, CodexEnvironment, CodexSkill, McpServer, Workspace } from "../domain";
import { buildPrompt, buildTitleSource, type SelectionInput } from "./promptBuilder";

export interface RuntimeStatus {
  available: boolean;
  version: string;
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
  return { available: false, version: "", codexHome: "", mode: "unavailable" };
}

interface NativeWorkspace { id: string; name: string; path: string; branch: string | null; lastUsedAt: number }
type NativeEnvironment = Omit<CodexEnvironment, "workspaces"> & { workspaces: NativeWorkspace[] };

const workspaceColors = ["#c8f46a", "#9b8afc", "#f6a969", "#68c7c1", "#f38f9c"];

function formatLastUsed(timestamp: number) {
  if (!timestamp) return "Unknown";
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - timestamp);
  if (seconds < 60) return "Now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 172_800) return "Yesterday";
  return `${Math.floor(seconds / 86_400)}d ago`;
}

export async function scanCodexEnvironment(workspacePath?: string, profile?: string): Promise<CodexEnvironment | null> {
  if (!isTauri()) return null;
  const snapshot = await invoke<NativeEnvironment>("scan_codex_environment", { workspacePath, profile });
  return {
    ...snapshot,
    workspaces: snapshot.workspaces.map((workspace, index) => ({
      id: workspace.id,
      name: workspace.name,
      path: workspace.path,
      branch: workspace.branch || "—",
      lastUsed: formatLastUsed(workspace.lastUsedAt),
      color: workspaceColors[index % workspaceColors.length],
    })),
  };
}

export async function startNativeRun(agent: CodexAgent, input: SelectionInput, skills: CodexSkill[] = [], mcps: McpServer[] = []) {
  const prompt = buildPrompt(agent, input);
  const titleSource = buildTitleSource(agent, input);
  if (!isTauri()) throw new Error("Native Codex runs require the Latch Bar desktop app");
  const resolvedSkills = skills
    .filter((skill) => agent.enabledSkills.includes(skill.id) && skill.path)
    .map((skill) => ({ id: skill.id, name: skill.name, path: skill.path! }));
  const resolvedMcpServers = mcps.filter((server) => server.configurable).map((server) => server.id);
  return invoke<{ runId: string; prompt: string }>("start_codex_run", {
    agent: { ...agent, resolvedSkills, resolvedMcpServers },
    prompt,
    titleSource,
  });
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
export const resizeContextBar = (height: number, width?: number, anchorX?: number) => invoke<void>("resize_context_bar", { height, width, anchorX });
export const setContextBarFocusable = (focusable: boolean) => invoke<void>("set_context_bar_focusable", { focusable });
export const replaceNativeSelection = (text: string) => invoke<{ method: string }>("replace_selection", { text });
export const copyNativeText = (text: string) => invoke<void>("copy_text", { text });
export const openStudio = () => invoke<void>("open_studio");
export const openCodexThread = (threadId: string) => openUrl(`codex://threads/${encodeURIComponent(threadId)}`);
export const interruptNativeRun = (runId: string) => invoke<void>("interrupt_codex_run", { runId });
export const stopNativeRun = (runId: string) => invoke<void>("stop_codex_run", { runId });
export const respondToApproval = (runId: string, requestId: string | number, response: unknown) => invoke<void>("respond_to_approval", { runId, requestId, response });
