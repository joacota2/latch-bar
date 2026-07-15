import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { LatchProvider } from "./store/LatchStore";

describe("Latch MVP", () => {
  beforeEach(() => { localStorage.clear(); vi.useRealTimers(); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("creates an agent and opens the complete editor", async () => {
    const user = userEvent.setup();
    render(<LatchProvider><App /></LatchProvider>);
    await user.click(screen.getByRole("button", { name: "New agent" }));
    expect(screen.getByRole("complementary", { name: "Agent editor" })).toBeInTheDocument();
    expect(screen.getByDisplayValue("Untitled agent")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "MCPs & Skills 0" })).toBeInTheDocument();
  });

  it("moves a permission-scoped agent from approval to result", async () => {
    vi.useFakeTimers();
    render(<LatchProvider><App /></LatchProvider>);
    fireEvent.click(screen.getByRole("button", { name: "⌘ Staff" }));
    await act(async () => { vi.advanceTimersByTime(1300); });
    expect(screen.getByRole("button", { name: "Allow once" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    expect(screen.getByText("Result ready")).toBeInTheDocument();
  });
});
