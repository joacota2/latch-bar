import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver = ResizeObserverMock;
Object.defineProperty(window.navigator, "clipboard", {
  value: { writeText: vi.fn() },
  configurable: true,
});

// Model cross-tab Web Locks in jsdom; production desktop uses native CAS.
let pendingLock: Promise<unknown> = Promise.resolve();
Object.defineProperty(navigator, "locks", {
  configurable: true,
  value: {
    request: (_name: string, callback: () => unknown) => {
      const next = pendingLock.then(callback, callback);
      pendingLock = next.catch(() => undefined);
      return next;
    },
  },
});

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: vi.fn(async () => () => {}),
    hide: vi.fn(async () => {}),
  }),
}));
