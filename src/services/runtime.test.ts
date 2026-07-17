import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getPlatformStatus, repairAccessibilityPermission, requestAccessibilityPermission } from "./runtime";

const platformStatus = {
  platform: "macos",
  supported: true,
  accessibilityTrusted: false,
  permissionRequired: "accessibility",
  implementation: "axuielement",
  monitorRunning: true,
  contextBarReady: true,
};

describe("Accessibility permission IPC", () => {
  afterEach(() => clearMocks());

  it("checks permission without prompting", async () => {
    const handler = vi.fn(() => platformStatus);
    mockIPC(handler);

    await expect(getPlatformStatus()).resolves.toEqual(platformStatus);
    expect(handler).toHaveBeenCalledWith("platform_status", { prompt: false });
  });

  it("prompts only through the explicit request API", async () => {
    const handler = vi.fn(() => platformStatus);
    mockIPC(handler);

    await expect(requestAccessibilityPermission()).resolves.toEqual(platformStatus);
    expect(handler).toHaveBeenCalledWith("platform_status", { prompt: true });
  });

  it("repairs a stale macOS permission through an explicit IPC action", async () => {
    const handler = vi.fn(() => platformStatus);
    mockIPC(handler);

    await expect(repairAccessibilityPermission()).resolves.toEqual(platformStatus);
    expect(handler).toHaveBeenCalledWith("repair_accessibility_permission", {});
  });
});
