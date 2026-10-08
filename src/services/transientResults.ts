import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Run } from "../domain";
import { isTauri, openStudio } from "./runtime";
export interface TransientResult { id: string; epoch: string; run: Run; persisted: boolean; acknowledged: boolean }
export interface TransientSnapshot { revision: number; result: TransientResult | null }
export const readTransientResult = () => isTauri() ? invoke<TransientSnapshot>("transient_result") : Promise.resolve({ revision: 0, result: null });
export const subscribeTransientResult = (callback: (snapshot: TransientSnapshot) => void) => isTauri() ? listen<TransientSnapshot>("latch-transient-result", ({ payload }) => callback(payload)) : Promise.resolve(() => {});
export const acknowledgeResult = (result: TransientResult) => invoke<void>("acknowledge_transient_result", { id: result.id, epoch: result.epoch });
export const dismissResult = (result: TransientResult) => invoke<void>("dismiss_transient_result", { id: result.id, epoch: result.epoch });
export async function handoffResult(run: Run, epoch: string, isCurrent = () => true): Promise<void> {
  let target: string | undefined;
  let latest: TransientSnapshot | undefined;
  let disposed = false;
  let unsubscribe: (() => void) | undefined;
  let resolveAck: () => void = () => {};
  const ack = new Promise<void>((resolve) => { resolveAck = resolve; });
  const accept = (snapshot: TransientSnapshot) => {
    if (disposed || !isCurrent() || (latest && latest.revision > snapshot.revision)) return;
    latest = snapshot;
    if (target && snapshot.result?.id === target && snapshot.result.epoch === epoch && snapshot.result.acknowledged) resolveAck();
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const operation = async () => {
      const stop = await subscribeTransientResult(accept);
      if (disposed || !isCurrent()) { stop(); throw new Error("Result transfer cancelled"); }
      unsubscribe = stop;
      // The native boundary retains only completed output and metadata.
      const output = { ...run }; delete output.conversation;
      const published = await invoke<TransientSnapshot>("publish_transient_result", { run: output, epoch });
      if (disposed || !isCurrent()) throw new Error("Result transfer cancelled");
      target = published.result?.id;
      if (!target) throw new Error("Studio could not receive the result");
      accept(published); if (latest) accept(latest);
      await openStudio(true);
      await ack;
    };
    await Promise.race([operation(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Studio did not confirm receipt. Your answer is still here. Retry or copy it.")), 5000); })]);
  } finally { disposed = true; clearTimeout(timer); unsubscribe?.(); }
}
