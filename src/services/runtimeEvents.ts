import type { RpcMessage, RuntimeEvent } from "./approvals";
/** Owns the transport buffer while startRun has not returned its run identity. */
export class RuntimeEventAdapter {
  private pending: RuntimeEvent[] = [];
  constructor(private current: () => { runId: string | null; starting: boolean }, private deliver: (message: RpcMessage) => void) {}
  receive(event: RuntimeEvent) {
    const { runId, starting } = this.current();
    if (!runId && starting) this.pending.push(event);
    else if (event.runId === runId) this.deliver(event.message);
  }
  reset() { this.pending = []; }
  started(runId: string) {
    const pending = this.pending; this.reset();
    for (const event of pending) if (event.runId === runId) this.deliver(event.message);
  }
}
