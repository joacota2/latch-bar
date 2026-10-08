import { z } from "zod";
import type { AppSettings, CodexAgent, Run, Workspace } from "../domain";
import { DEFAULT_AGENTS_VERSION, seedAgents, seedSettings } from "../data/seed";
import { agentConfigSchema } from "./agentConfig";

const persistedAgentSchema = agentConfigSchema.extend({
  id: z.string(),
  order: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const runSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  agentName: z.string(),
  agentIcon: z.string(),
  status: z.enum(["running", "approval", "completed", "failed", "cancelled"]),
  sourceApplication: z.string(),
  sourceIcon: z.string(),
  activity: z.string(),
  model: z.string(),
  sandbox: z.enum(["read-only", "workspace-write", "full-access"]),
  startedAt: z.string(),
  duration: z.string().optional(),
  threadId: z.string().optional(),
  workspacePath: z.string().optional(),
  finalResponse: z.string().optional(),
  command: z.string().optional(),
  conversation: z
    .array(
      z.object({
        id: z.string(),
        role: z.enum(["user", "assistant"]),
        text: z.string(),
      }),
    )
    .optional(),
});
function validSettings(input: AppSettings): AppSettings {
  const out = { ...seedSettings };
  for (const key of [
    "contextBarEnabled",
    "storeHistory",
    "storeSelectedText",
    "redactWindowTitles",
  ] as const) {
    if (typeof input[key] === "boolean") out[key] = input[key];
  }
  if (
    Number.isInteger(input.selectionDelay) &&
    input.selectionDelay >= 0 &&
    input.selectionDelay <= 800
  )
    out.selectionDelay = input.selectionDelay;
  if (
    Number.isInteger(input.minimumCharacters) &&
    input.minimumCharacters >= 1 &&
    input.minimumCharacters <= 100
  )
    out.minimumCharacters = input.minimumCharacters;
  if (
    Array.isArray(input.excludedApplications) &&
    input.excludedApplications.every((value) => typeof value === "string")
  )
    out.excludedApplications = input.excludedApplications;
  return out;
}
export interface PersistedState {
  schemaVersion?: number;
  defaultAgentsVersion?: number;
  agents?: CodexAgent[];
  runs?: Run[];
  settings?: AppSettings;
  savedWorkspaces?: Workspace[];
}

export function normalizePersisted(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const parsed = input as PersistedState;
  const legacySeedIds = new Set([
    "run-security",
    "run-writing",
    "run-error",
    "run-plan",
  ]);
  let agents = (Array.isArray(parsed.agents) ? parsed.agents : undefined)
    ?.filter((agent) => agent && typeof agent === "object")
    .map((agent) => {
      const current = { ...agent } as Omit<CodexAgent, "outputPolicy"> & {
        outputPolicy?: Partial<CodexAgent["outputPolicy"]>;
        speed?: string;
      };
      delete current.speed;
      const defaultOutputPolicy =
        seedAgents.find((seed) => seed.id === current.id)?.outputPolicy ??
        seedAgents[0].outputPolicy;
      const mode = current.outputPolicy?.mode ?? defaultOutputPolicy.mode;
      return {
        ...current,
        model: current.model === "custom" ? "default" : current.model,
        serviceTier: current.serviceTier ?? "default",
        outputPolicy: {
          ...defaultOutputPolicy,
          ...current.outputPolicy,
          mode,
          allowReplace:
            current.outputPolicy?.allowReplace ??
            (current.outputPolicy?.mode
              ? mode !== "open-studio"
              : defaultOutputPolicy.allowReplace),
        },
      } satisfies CodexAgent;
    });
  if (agents && (parsed.defaultAgentsVersion ?? 0) < DEFAULT_AGENTS_VERSION) {
    // Retire built-in IDs only; user-created agents and duplicates keep their own IDs.
    const retiredIds = new Set([
      "staff-engineer",
      "ui-reviewer",
      "explain-error",
      "plan-implementation",
    ]);
    agents = agents.filter((agent) => !retiredIds.has(agent.id));
    const addedIds = new Set(["summarize", "explain-simply", "draft-reply"]);
    const existingIds = new Set(agents.map((agent) => agent.id));
    let nextOrder =
      agents.reduce(
        (max, agent) =>
          Math.max(max, Number.isFinite(agent.order) ? agent.order : -1),
        -1,
      ) + 1;
    const additions = seedAgents.filter(
      (agent) => addedIds.has(agent.id) && !existingIds.has(agent.id),
    );
    agents = [
      ...agents,
      ...additions.map((agent) => ({ ...agent, order: nextOrder++ })),
    ];
  }
  const settings =
    parsed.settings && typeof parsed.settings === "object"
      ? ({ ...seedSettings, ...parsed.settings } as AppSettings & {
          codexHome?: string;
          studioAppearance?: string;
          contextBarAppearance?: string;
        })
      : undefined;
  if (settings) {
    delete settings.codexHome;
    delete settings.studioAppearance;
    delete settings.contextBarAppearance;
  }
  return {
    ...parsed,
    defaultAgentsVersion: Math.max(
      Number.isFinite(parsed.defaultAgentsVersion)
        ? parsed.defaultAgentsVersion!
        : 0,
      DEFAULT_AGENTS_VERSION,
    ),
    agents: agents?.flatMap((agent) => { const result = persistedAgentSchema.safeParse(agent); return result.success ? [result.data] : []; }),
    settings: settings ? validSettings(settings) : undefined,
    savedWorkspaces: Array.isArray(parsed.savedWorkspaces)
      ? parsed.savedWorkspaces.flatMap((item) => {
          if (!item || typeof item.path !== "string" || !item.path) return [];
          return [
            {
              id: item.path,
              path: item.path,
              name:
                typeof item.name === "string"
                  ? item.name
                  : item.path.split("/").pop() || item.path,
              branch: typeof item.branch === "string" ? item.branch : "—",
              lastUsed:
                typeof item.lastUsed === "string" ? item.lastUsed : "Saved",
              color: typeof item.color === "string" ? item.color : "#c8f46a",
              saved: true,
            },
          ];
        })
      : [],
    runs:
      parsed.settings?.storeHistory === false
        ? []
        : (Array.isArray(parsed.runs) ? parsed.runs : []).filter(
            (run) =>
              runSchema.safeParse(run).success &&
              !legacySeedIds.has(run.id) &&
              run.sourceApplication !== "Selection preview" &&
              !run.threadId?.startsWith("thr_preview_"),
          ),
  };
}

export type SavedState = Required<PersistedState>;
export function completeState(input: unknown): SavedState {
  const parsed = normalizePersisted(input);
  return {
    schemaVersion: 2,
    defaultAgentsVersion:
      parsed?.defaultAgentsVersion ?? DEFAULT_AGENTS_VERSION,
    agents: parsed?.agents ?? seedAgents,
    runs: parsed?.runs ?? [],
    settings: parsed?.settings ?? seedSettings,
    savedWorkspaces: parsed?.savedWorkspaces ?? [],
  };
}
export function privateState(next: SavedState): SavedState {
  return {
    ...next,
    runs: next.settings.storeHistory
      ? next.runs.slice(0, 200).map((run) => ({
          ...run,
          conversation: next.settings.storeSelectedText
            ? run.conversation
            : run.conversation?.filter(
                (message) => message.id !== "selected-text",
              ),
        }))
      : [],
  };
}
