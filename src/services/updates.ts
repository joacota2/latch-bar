import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "./runtime";

export type UpdatePhase =
  | "unavailable"
  | "idle"
  | "checking"
  | "upToDate"
  | "available"
  | "downloading"
  | "installing"
  | "restarting"
  | "error";
export interface UpdateState {
  revision: number;
  enabled: boolean;
  currentVersion: string;
  phase: UpdatePhase;
  availableVersion: string | null;
  notes: string | null;
  lastCheckedAt: number | null;
  downloadedBytes: number;
  totalBytes: number | null;
  error: string | null;
}

export const unavailableUpdate: UpdateState = {
  revision: 0,
  enabled: false,
  currentVersion: "",
  phase: "unavailable",
  availableVersion: null,
  notes: null,
  lastCheckedAt: null,
  downloadedBytes: 0,
  totalBytes: null,
  error: null,
};
export const installingUpdate = (phase: UpdatePhase) =>
  ["downloading", "installing", "restarting"].includes(phase);
export const getUpdateState = () =>
  isTauri()
    ? invoke<UpdateState>("update_state")
    : Promise.resolve(unavailableUpdate);
export const checkForUpdates = () => invoke<UpdateState>("check_for_updates");
export const installUpdate = () => invoke<void>("install_update");
export const setUpdateEditorState = (open: boolean) =>
  isTauri() ? invoke<void>("update_editor_state", { open }) : Promise.resolve();
export const onUpdateState = (callback: (state: UpdateState) => void) =>
  isTauri()
    ? listen<UpdateState>("latch-update-state", (event) =>
        callback(event.payload),
      )
    : Promise.resolve(() => {});
