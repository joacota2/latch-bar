import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "./runtime";
import { completeState, privateState, type SavedState } from "./persistedState";

export const STORAGE_KEY = "latch-bar-state-v1";
const EVENT = "latch-state-changed";
const LOCK = "latch-state-write";
export interface Snapshot {
  revision: number;
  epoch: string;
  state: SavedState;
}
export type Change = (current: SavedState) => SavedState;

export function browserSnapshot(): Snapshot {
  const raw = localStorage.getItem(STORAGE_KEY);
  let parsed;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  return {
    revision: Number.isSafeInteger(parsed?.__revision) ? parsed.__revision : 0,
    epoch: typeof parsed?.__epoch === "string" ? parsed.__epoch : "legacy",
    state: completeState(parsed),
  };
}
export async function readState(): Promise<Snapshot> {
  if (!isTauri()) return browserSnapshot();
  const snapshot = await invoke<Snapshot>("read_latch_state", {
    initial: browserSnapshot().state,
  });
  localStorage.removeItem(STORAGE_KEY); // Retire the legacy copy after durable migration.
  return { ...snapshot, state: completeState(snapshot.state) };
}

// Mutations are recalculated against the winning revision. A reset changes epoch,
// so queued callbacks from the old context cannot recreate cleared data.
export async function changeState(
  change: Change,
  epoch: string,
  reset = false,
): Promise<Snapshot | null> {
  if (isTauri()) {
    for (let attempt = 0; attempt < 32; attempt++) {
      const current = await readState();
      if (current.epoch !== epoch) return null;
      const state = privateState(change(current.state));
      const result = await invoke<{ accepted: boolean; snapshot: Snapshot }>(
        "write_latch_state",
        {
          revision: current.revision,
          epoch,
          state,
          reset,
        },
      );
      if (result.accepted)
        return {
          ...result.snapshot,
          state: completeState(result.snapshot.state),
        };
    }
    throw new Error(
      "Changes are arriving too quickly. Please try saving again.",
    );
  }
  return changeBrowserState(change, epoch, reset);
}

export async function changeBrowserState(
  change: Change,
  epoch: string,
  reset = false,
): Promise<Snapshot | null> {
  // Web Locks serialize tabs/processes; refusing writes is safer than a lossy
  // fallback on unsupported browser engines. The desktop uses the native mutex.
  if (!navigator.locks)
    throw new Error(
      "This browser cannot safely save shared state. Use the desktop app.",
    );
  return navigator.locks.request(LOCK, async () => {
    const current = browserSnapshot();
    if (current.epoch !== epoch) return null;
    const next = {
      revision: current.revision + 1,
      epoch: reset ? crypto.randomUUID() : epoch,
      state: privateState(change(current.state)),
    };
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ...next.state,
        __revision: next.revision,
        __epoch: next.epoch,
      }),
    );
    window.dispatchEvent(new Event(EVENT));
    return next;
  });
}

export async function subscribeState(refresh: () => void): Promise<() => void> {
  if (isTauri()) return listen(EVENT, refresh);
  const storage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === null) refresh();
  };
  window.addEventListener("storage", storage);
  window.addEventListener(EVENT, refresh);
  return () => {
    window.removeEventListener("storage", storage);
    window.removeEventListener(EVENT, refresh);
  };
}
