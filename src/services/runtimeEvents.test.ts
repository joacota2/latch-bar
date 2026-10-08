import { expect, it, vi } from "vitest";
import { RuntimeEventAdapter } from "./runtimeEvents";
import { performOutputAction } from "./outputActions";
import { seedAgents } from "../data/seed";
import type { NativeSelection } from "../domain";
it("buffers events until the returned identity is known and rejects other runs after reset", () => {
  let current: { runId: string | null; starting: boolean } = {
    runId: null,
    starting: true,
  };
  const receive = vi.fn();
  const adapter = new RuntimeEventAdapter(() => current, receive);
  adapter.receive({ runId: "unrelated", message: { method: "wrong" } });
  adapter.receive({ runId: "ours", message: { method: "right" } });
  current = { runId: "ours", starting: false };
  adapter.started("ours");
  expect(receive).toHaveBeenCalledExactlyOnceWith({ method: "right" });
  current = { runId: null, starting: false };
  adapter.reset();
  adapter.receive({ runId: "ours", message: { method: "late" } });
  expect(receive).toHaveBeenCalledOnce();
});
it("does not retry consumed replacements and explains copy-only positions", async () => {
  const actions = {
    copy: vi.fn(),
    replace: vi.fn(),
    studio: vi.fn(),
    explain: vi.fn(),
  };
  const source: NativeSelection = {
    selectionId: "selection",
    text: "same",
    application: "Editor",
    processId: 1,
    bounds: { x: 0, y: 0, width: 1, height: 1 },
    replacementCapability: "none",
    replacementUnavailableReason: "Position unavailable",
  };
  const agent = {
    ...seedAgents[0],
    outputPolicy: { ...seedAgents[0].outputPolicy, mode: "replace" as const },
  };
  await performOutputAction(agent, source, "answer", false, actions);
  expect(actions.explain).toHaveBeenCalledWith("Position unavailable");
  await performOutputAction(
    agent,
    { ...source, replacementCapability: "accessibility" },
    "answer",
    true,
    actions,
  );
  expect(actions.replace).not.toHaveBeenCalled();
  await performOutputAction(
    { ...agent, outputPolicy: { ...agent.outputPolicy, mode: "open-studio" } },
    source,
    "answer",
    false,
    actions,
  );
  expect(actions.studio).toHaveBeenCalledOnce();
});
