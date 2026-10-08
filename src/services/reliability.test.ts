import { describe, expect, it, vi } from "vitest";
import { approvalKey, approvalResponse, parseApproval } from "./approvals";
import { contextSessionReducer as reduce, initialSession, type ContextSession } from "./contextSession";
import { environmentKey, resolveSkillIds, validateRuntimeAgent } from "./environments";
import { randomUUID } from "./compat";
import { seedAgents } from "../data/seed";
import { emptyCatalog } from "../test/environment";
import { completeState } from "./persistedState";
import { getAgentConfig, parseAgentConfig, serializeAgentConfig } from "./agentConfig";
const request = (id: number | string) => parseApproval("run", { id, method: "item/commandExecution/requestApproval", params: { command: "npm test", cwd: "/repo", reason: "Verify", networkApprovalContext: { host: "example.test", protocol: "https" }, env: { SECRET: "never display" } } })!;
describe("approval lifecycle", () => {
  it("discloses scope without environment secrets", () => {
    const approval = request(1);
    expect(approval.details.map((item) => item.text)).toEqual(["npm test", "/repo", "Verify", "https example.test"]);
    expect(JSON.stringify(approval.details)).not.toContain("SECRET");
    const permission = parseApproval("run", { id: "p", method: "item/permissions/requestApproval", params: { permissions: { fileSystem: { read: ["/read"], write: ["/write"] }, network: { enabled: true } } } })!;
    expect(permission.allowLabel).toBe("Allow for this turn");
    expect(permission.details.map((detail) => detail.text)).toEqual(["/read", "/write", "Enabled", "This turn only"]);
    expect(approvalResponse(permission, true)).toMatchObject({ scope: "turn", permissions: { network: { enabled: true } } });
  });
  it("rejects unsupported permission grants but keeps denial", () => {
    const approval = parseApproval("run", { id: 1, method: "item/permissions/requestApproval", params: { permissions: { unknown: true } } })!;
    expect(approval.supported).toBe(false); expect(() => approvalResponse(approval, true)).toThrow();
    expect(approvalResponse(approval, false)).toEqual({ permissions: {}, scope: "turn" });
    expect(parseApproval("run", { id: 2, method: "item/fileChange/requestApproval" })!.details).toContainEqual({ label: "Preview", text: "Codex did not provide a file-change preview with this request." });
  });
  it("queues mixed IDs, deduplicates answered requests, and ignores stale work", () => {
    let state: ContextSession = { ...initialSession, runId: "run" };
    for (const id of [1, "1", 1]) state = reduce(state, { type: "approval", generation: 0, approval: request(id) });
    expect(state.approvals).toHaveLength(2);
    state = reduce(state, { type: "answered", generation: 0, key: approvalKey("run", 1) });
    expect(state.state).toBe("approval"); expect(state.approvals[0].requestId).toBe("1");
    state = reduce(state, { type: "approval", generation: 0, approval: request(1) }); expect(state.approvals).toHaveLength(1);
    state = reduce(state, { type: "reset" });
    expect(reduce(state, { type: "patch", generation: 0, patch: { result: "stale" } })).toBe(state);
    expect(reduce(state, { type: "answered", generation: 0, key: approvalKey("run", "1") })).toBe(state);
    expect(state.approvals).toHaveLength(0);
  });
});
describe("migration and compatibility", () => {
  const skill = { id: "skill:v1:a", legacyId: "review", name: "Review", description: "Review", path: "/a/SKILL.md", source: "user" as const, enabled: true, compatible: true, validationErrors: [] };
  it("migrates unique slugs only and blocks missing or ambiguous explicit selections", () => {
    expect(resolveSkillIds(["review"], [skill])).toEqual({ resolved: [skill.id], unresolved: [] });
    const duplicates = [skill, { ...skill, id: "skill:v1:b", path: "/b/SKILL.md" }];
    expect(resolveSkillIds(["review"], duplicates).unresolved).toEqual(["review"]);
    expect(() => validateRuntimeAgent({ ...seedAgents[0], enabledSkills: ["review"] }, { ...emptyCatalog, skills: duplicates })).toThrow(/Reselect/);
    expect(resolveSkillIds([skill.id, "missing"], duplicates)).toEqual({ resolved: [skill.id, "missing"], unresolved: ["missing"] });
    expect(environmentKey("/")).not.toBe(environmentKey());
    expect(environmentKey("/repo//", "default")).toBe(environmentKey("/repo"));
    expect(environmentKey(undefined, "A")).not.toBe(environmentKey(undefined, "B"));
  });
  it("accepts v1/unwrapped imports, exports v2, and discards retired fields idempotently", () => {
    const agent = seedAgents[0]; const config = getAgentConfig(agent);
    const legacy = { ...config, contextPolicy: { ...config.contextPolicy, includeClipboard: true, includeScreenshot: true } };
    expect(parseAgentConfig(JSON.stringify({ version: 1, agent: legacy }))).toEqual(config);
    expect(parseAgentConfig(JSON.stringify(legacy))).toEqual(config);
    expect(parseAgentConfig(serializeAgentConfig(agent))).toEqual(config);
    expect(JSON.parse(serializeAgentConfig(agent)).version).toBe(2);
    const saved = completeState({ agents: [{ ...agent, ...legacy }], settings: { launchAtLogin: true, showMenuBar: true } });
    expect(saved.schemaVersion).toBe(2); expect(saved.settings).not.toHaveProperty("launchAtLogin");
    expect(saved.agents[0].contextPolicy).not.toHaveProperty("includeClipboard");
    expect(completeState(saved)).toEqual(saved);
  });
  it("generates secure version-4 UUIDs without randomUUID", () => {
    vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto), randomUUID: undefined });
    try { const first = randomUUID(); expect(first).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/); expect(randomUUID()).not.toBe(first); } finally { vi.unstubAllGlobals(); }
  });
});
