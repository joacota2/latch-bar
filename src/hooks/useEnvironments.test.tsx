import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useEnvironments } from "./useEnvironments";
import { emptyCatalog } from "../test/environment";
const scan = vi.hoisted(() => vi.fn());
vi.mock("../services/runtime", () => ({
  isTauri: () => true,
  scanCodexEnvironment: scan,
}));
it("isolates profile A, default, and B when scans finish in reverse order", async () => {
  const pending: ((value: typeof emptyCatalog) => void)[] = [];
  scan.mockImplementation(
    () => new Promise((resolve) => pending.push(resolve)),
  );
  const { result } = renderHook(useEnvironments);
  let a!: Promise<unknown>, base!: Promise<unknown>, b!: Promise<unknown>;
  act(() => {
    a = result.current.refresh("/repo", "A");
    base = result.current.refresh();
    b = result.current.refresh("/repo", "B");
  });
  await waitFor(() => expect(pending).toHaveLength(3));
  await act(async () => {
    pending[2]({ ...emptyCatalog, userAgent: "B" });
    await b;
  });
  expect(result.current.get("/repo", "A").status).toBe("loading");
  await act(async () => {
    pending[1](emptyCatalog);
    await base;
    pending[0]({ ...emptyCatalog, userAgent: "A" });
    await a;
  });
  expect(result.current.base.environment?.userAgent).toBe("fixture");
  expect(result.current.get("/repo", "A").environment?.userAgent).toBe("A");
  expect(result.current.get("/repo", "B").environment?.userAgent).toBe("B");
});
