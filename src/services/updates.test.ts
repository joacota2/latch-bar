import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getUpdateState,
  onUpdateState,
  setUpdateEditorState,
  unavailableUpdate,
} from "./updates";

const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen }));

describe("browser update fallback", () => {
  beforeEach(() => vi.clearAllMocks());
  it("does not invoke native commands or listeners in the browser", async () => {
    expect(await getUpdateState()).toEqual(unavailableUpdate);
    await setUpdateEditorState(true);
    const dispose = await onUpdateState(() => {});
    dispose();
    expect(native.invoke).not.toHaveBeenCalled();
    expect(native.listen).not.toHaveBeenCalled();
  });
});
