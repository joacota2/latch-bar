import { useCallback, useRef, useState } from "react";
import { isTauri, scanCodexEnvironment } from "../services/runtime";
import { emptyEnvironment, environmentKey, type EnvironmentEntry } from "../services/environments";
import type { CodexEnvironment } from "../domain";
export function useEnvironments() {
  const [entries, setEntries] = useState<Record<string, EnvironmentEntry>>({});
  const requests = useRef(new Map<string, number>());
  const inFlight = useRef(new Map<string, Promise<CodexEnvironment | null>>());
  const refresh = useCallback((workspace?: string, profile?: string, forceRefresh = false): Promise<CodexEnvironment | null> => {
    const key = environmentKey(workspace, profile);
    const existing = inFlight.current.get(key);
    if (existing && !forceRefresh) return existing;
    const request = (requests.current.get(key) ?? 0) + 1;
    requests.current.set(key, request);
    const publish = (entry: EnvironmentEntry) => { if (requests.current.get(key) === request) setEntries((current) => ({ ...current, [key]: entry })); };
    const operation = async () => {
      if (!isTauri()) { publish({ ...emptyEnvironment, status: "unavailable" }); return null; }
      publish({ ...emptyEnvironment, status: "loading" });
      try {
        const environment = await scanCodexEnvironment(workspace?.trim() || undefined, profile?.trim() || undefined, forceRefresh);
        publish({ environment, status: environment ? "ready" : "unavailable", error: "" });
        return environment;
      } catch (error) { publish({ ...emptyEnvironment, status: "error", error: String(error) }); return null; }
      finally { if (requests.current.get(key) === request) inFlight.current.delete(key); }
    };
    const promise = Promise.resolve().then(operation); inFlight.current.set(key, promise); return promise;
  }, []);
  const get = useCallback((workspace?: string, profile?: string) => entries[environmentKey(workspace, profile)] ?? emptyEnvironment, [entries]);
  return { get, refresh, base: get() };
}
