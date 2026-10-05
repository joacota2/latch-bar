import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getPlatformStatus, isTauri, relaunchApp, repairAccessibilityPermission, requestAccessibilityPermission, requestFolderAccess, type FolderAccess, type PlatformStatus, type ProtectedFolder } from "../services/runtime";
import { useLatch } from "./LatchStore";

const FOLDER_ACCESS_KEY = "latch-folder-access";
const POLL_INTERVAL_MS = 1500;
const protectedFolderPattern = /^\/Users\/[^/]+\/(Desktop|Documents|Downloads)(\/|$)/;

export type FolderAccessState = Partial<Record<ProtectedFolder, FolderAccess>>;

interface Permissions {
  platform: PlatformStatus | null;
  /** Protected folders Latch needs: Documents for runs without a workspace, plus any workspace location. */
  folders: ProtectedFolder[];
  folderAccess: FolderAccessState;
  /** The Context Bar is on, but cannot work until the person finishes permission setup. */
  needsSetup: boolean;
  busy: boolean;
  viewRequest: number;
  refresh: () => Promise<PlatformStatus | null>;
  requestAccessibility: () => Promise<void>;
  requestFolders: () => Promise<void>;
  setUp: () => Promise<void>;
  repairAccessibility: () => Promise<void>;
  relaunch: () => Promise<void>;
  view: () => void;
}

const PermissionContext = createContext<Permissions>({
  platform: null, folders: ["documents"], folderAccess: {}, needsSetup: false, busy: false, viewRequest: 0,
  refresh: async () => null, requestAccessibility: async () => {}, requestFolders: async () => {}, setUp: async () => {},
  repairAccessibility: async () => {}, relaunch: async () => {}, view: () => {},
});

function readFolderAccess(): FolderAccessState {
  try {
    const value = JSON.parse(localStorage.getItem(FOLDER_ACCESS_KEY) ?? "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function writeFolderAccess(value: FolderAccessState) {
  try { localStorage.setItem(FOLDER_ACCESS_KEY, JSON.stringify(value)); } catch { /* Folder status is rechecked on the next request. */ }
}

export function needsPermissionSetup(platform: PlatformStatus | null) {
  return Boolean(platform?.supported && (!platform.accessibilityTrusted || platform.restartRecommended));
}

export function PermissionProvider({ children }: { children: ReactNode }) {
  const { settings, workspaces, setActiveNav, notify } = useLatch();
  const [platform, setPlatform] = useState<PlatformStatus | null>(null);
  const [folderAccess, setFolderAccess] = useState<FolderAccessState>(readFolderAccess);
  const [busy, setBusy] = useState(false);
  const [viewRequest, setViewRequest] = useState(0);
  const operation = useRef(false);

  const folders = useMemo(() => {
    const needed = new Set<ProtectedFolder>(["documents"]);
    for (const workspace of workspaces) {
      const match = protectedFolderPattern.exec(workspace.path);
      if (match) needed.add(match[1].toLowerCase() as ProtectedFolder);
    }
    return [...needed];
  }, [workspaces]);

  const refresh = useCallback(async () => {
    try {
      const status = await getPlatformStatus();
      setPlatform(status);
      return status;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, [refresh]);

  const applyFolderResults = useCallback((results: FolderAccess[]) => {
    if (results.length === 0) return;
    setFolderAccess((current) => {
      const next = { ...current };
      for (const result of results) next[result.folder] = result;
      writeFolderAccess(next);
      return next;
    });
  }, []);

  // Folders the person already answered for never prompt again, so refresh their
  // real status at startup in case it changed in System Settings.
  useEffect(() => {
    const answered = Object.keys(readFolderAccess()) as ProtectedFolder[];
    if (answered.length) void requestFolderAccess(answered).then(applyFolderResults).catch(() => undefined);
  }, [applyFolderResults]);

  const exclusive = useCallback(async (task: () => Promise<void>) => {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    try { await task(); } finally { operation.current = false; setBusy(false); }
  }, []);

  const askAccessibility = useCallback(async () => {
    const status = await requestAccessibilityPermission();
    setPlatform(status);
  }, []);

  const askFolders = useCallback(async () => {
    applyFolderResults(await requestFolderAccess(folders));
  }, [applyFolderResults, folders]);

  const requestAccessibility = useCallback(() => exclusive(async () => {
    try { await askAccessibility(); } catch { notify("Could not request Accessibility permission"); }
  }), [askAccessibility, exclusive, notify]);

  const requestFolders = useCallback(() => exclusive(async () => {
    try { await askFolders(); } catch { notify("Could not request folder access"); }
  }), [askFolders, exclusive, notify]);

  // Ask for everything in one pass. Folder prompts are answered in place, so they
  // come first; the Accessibility prompt hands the person off to System Settings.
  const setUp = useCallback(() => exclusive(async () => {
    try {
      await askFolders();
      const status = await getPlatformStatus();
      setPlatform(status);
      if (status.supported && !status.accessibilityTrusted) {
        await askAccessibility();
        notify("Turn on Latch Bar in System Settings → Accessibility. Latch detects it automatically.");
      }
    } catch {
      notify("Could not finish permission setup");
    }
  }), [askAccessibility, askFolders, exclusive, notify]);

  const repairAccessibility = useCallback(() => exclusive(async () => {
    try {
      setPlatform(await repairAccessibilityPermission());
      notify("The stale Accessibility entry was reset. Enable the current Latch Bar copy in macOS Settings.");
    } catch {
      notify("Could not repair Accessibility permission");
    }
  }), [exclusive, notify]);

  const relaunch = useCallback(async () => {
    try { await relaunchApp(); } catch { notify("Could not relaunch Latch Bar. Quit and reopen it."); }
  }, [notify]);

  const view = useCallback(() => {
    setActiveNav("settings");
    setViewRequest((value) => value + 1);
  }, [setActiveNav]);

  const value = useMemo<Permissions>(() => ({
    platform, folders, folderAccess, busy, viewRequest,
    needsSetup: settings.contextBarEnabled && needsPermissionSetup(platform),
    refresh, requestAccessibility, requestFolders, setUp, repairAccessibility, relaunch, view,
  }), [busy, folderAccess, folders, platform, refresh, relaunch, repairAccessibility, requestAccessibility, requestFolders, settings.contextBarEnabled, setUp, view, viewRequest]);

  return <PermissionContext.Provider value={value}>{children}</PermissionContext.Provider>;
}

export const usePermissions = () => useContext(PermissionContext);
