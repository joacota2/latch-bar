import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { checkForUpdates, getUpdateState, installUpdate, installingUpdate, onUpdateState, setUpdateEditorState, unavailableUpdate, type UpdateState } from "../services/updates";
import { useLatch } from "./LatchStore";

interface Updates {
  state: UpdateState;
  busy: boolean;
  installing: boolean;
  error: string | null;
  dismissedVersion: string | null;
  viewRequest: number;
  check: () => Promise<void>;
  install: () => Promise<void>;
  dismiss: () => void;
  view: () => void;
}
const UpdateContext = createContext<Updates>({
  state: unavailableUpdate, busy: false, installing: false, error: null, dismissedVersion: null, viewRequest: 0,
  check: async () => {}, install: async () => {}, dismiss: () => {}, view: () => {},
});

export function UpdateProvider({ children }: { children: ReactNode }) {
  const { selectedAgentId, setActiveNav } = useLatch();
  const [state, setState] = useState(unavailableUpdate);
  const [pending, setPending] = useState(false);
  const [installationRequested, setInstallationRequested] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  const [viewRequest, setViewRequest] = useState(0);
  const operation = useRef(false);
  const accept = (next: UpdateState) => setState((current) => next.revision >= current.revision ? next : current);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    // Listen first, then snapshot: neither a late snapshot nor a remount can
    // lose an in-flight operation or overwrite a newer event.
    void onUpdateState((next) => { if (!disposed) accept(next); }).then(async (dispose) => {
      if (disposed) { dispose(); return; }
      unlisten = dispose;
      const next = await getUpdateState();
      if (!disposed) accept(next);
    }).catch(() => { if (!disposed) setError("Could not read update status. Reopen Studio to retry."); });
    return () => { disposed = true; unlisten?.(); };
  }, []);

  useEffect(() => {
    void setUpdateEditorState(Boolean(selectedAgentId)).catch((cause) => setError(String(cause)));
  }, [selectedAgentId]);

  const perform = async (action: () => Promise<void>) => {
    if (operation.current || state.phase === "checking" || installingUpdate(state.phase) || !state.enabled) return;
    operation.current = true;
    setPending(true);
    setError(null);
    try { await action(); }
    catch (cause) { setError(String(cause)); }
    finally { operation.current = false; setPending(false); }
  };
  const check = () => perform(async () => accept(await checkForUpdates()));
  const install = () => perform(async () => {
    if (selectedAgentId) throw new Error("Save your changes and close the agent editor before updating.");
    setInstallationRequested(true);
    try {
      await setUpdateEditorState(false);
      await installUpdate();
    } finally { setInstallationRequested(false); }
  });

  return <UpdateContext.Provider value={{
    state, busy: pending || state.phase === "checking" || installingUpdate(state.phase), error,
    installing: installationRequested || installingUpdate(state.phase),
    dismissedVersion, viewRequest, check, install,
    dismiss: () => setDismissedVersion(state.availableVersion),
    view: () => { setActiveNav("settings"); setViewRequest((value) => value + 1); },
  }}>{children}</UpdateContext.Provider>;
}

export const useUpdates = () => useContext(UpdateContext);
