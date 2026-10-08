import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Run } from "../domain";
import { handoffResult, type TransientSnapshot } from "./transientResults";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn(), unsubscribe: vi.fn(), listener: null as null | ((event: { payload: TransientSnapshot }) => void) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (_: string, listener: typeof mocks.listener) => { mocks.listener = listener; return mocks.unsubscribe; }) }));
vi.mock("./runtime", () => ({ isTauri: () => true, openStudio: mocks.open }));
const run: Run = { id: "same-history-id", agentId: "agent", agentName: "Agent", agentIcon: "A", status: "completed", finalResponse: "Answer", activity: "Done", model: "default", sandbox: "read-only", startedAt: "now", sourceApplication: "Editor", sourceIcon: "E", conversation: [{ id: "selected-text", role: "user", text: "PRIVATE" }] };
const snapshot: TransientSnapshot = { revision: 1, result: { id: "transfer", epoch: "epoch", run, persisted: false, acknowledged: false } };
beforeEach(() => { vi.clearAllMocks(); mocks.invoke.mockResolvedValue(snapshot); mocks.open.mockResolvedValue(undefined); });
afterEach(() => { vi.useRealTimers(); });
it("subscribes before publishing and waits for mount acknowledgement without sending original context", async () => {
  const finished = vi.fn(); const transfer = handoffResult(run, "epoch").then(finished);
  await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledWith(true));
  expect(finished).not.toHaveBeenCalled();
  expect(mocks.invoke.mock.calls[0]).toEqual(["publish_transient_result", { epoch: "epoch", run: { ...run, conversation: undefined } }]);
  expect(JSON.stringify(mocks.invoke.mock.calls)).not.toContain("PRIVATE");
  mocks.listener!({ payload: { revision: 2, result: { ...snapshot.result!, acknowledged: true } } });
  await transfer; expect(finished).toHaveBeenCalledOnce(); expect(mocks.unsubscribe).toHaveBeenCalledOnce();
});
it("handles acknowledgement arriving before the publish command returns", async () => {
  mocks.invoke.mockImplementation(async () => { mocks.listener!({ payload: { revision: 2, result: { ...snapshot.result!, acknowledged: true } } }); return snapshot; });
  await handoffResult(run, "epoch"); expect(mocks.unsubscribe).toHaveBeenCalledOnce();
});
it("keeps a timeout retryable and ignores acknowledgement for another epoch", async () => {
  vi.useFakeTimers();
  const transfer = handoffResult(run, "epoch"); const failed = expect(transfer).rejects.toThrow(/Retry or copy/);
  await vi.advanceTimersByTimeAsync(1);
  mocks.listener!({ payload: { revision: 2, result: { ...snapshot.result!, epoch: "reset", acknowledged: true } } });
  await vi.advanceTimersByTimeAsync(5000); await failed;
  expect(mocks.unsubscribe).toHaveBeenCalledOnce();
});
it("does not open Studio for a cancelled selection after slow publishing", async () => {
  let current = true; let publish!: (snapshot: TransientSnapshot) => void;
  mocks.invoke.mockImplementation(() => new Promise((resolve) => { publish = resolve; }));
  const transfer = handoffResult(run, "epoch", () => current); const failed = expect(transfer).rejects.toThrow(/cancelled/);
  await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalled()); current = false; publish(snapshot);
  await failed; expect(mocks.open).not.toHaveBeenCalled();
});
