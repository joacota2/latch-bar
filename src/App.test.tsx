import { cleanup, render, screen, within } from "@testing-library/react";
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

  it("does not render a simulated Context Bar in Studio", () => {
    render(<LatchProvider><App /></LatchProvider>);
    expect(screen.queryByRole("region", { name: "Latch Context Bar" })).not.toBeInTheDocument();
  });

  it("searches across Studio and opens an agent result", async () => {
    const user = userEvent.setup();
    render(<LatchProvider><App /></LatchProvider>);
    await user.click(screen.getByRole("button", { name: /Search/ }));
    expect(screen.getByRole("dialog", { name: "Search Latch" })).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Search Latch" }), "Translate to English");
    await user.click(within(screen.getByRole("dialog", { name: "Search Latch" })).getByRole("button", { name: /Translate to English/ }));
    expect(screen.getByRole("complementary", { name: "Agent editor" })).toBeInTheDocument();
    expect(screen.getByDisplayValue("Translate to English")).toBeInTheDocument();
  });

  it("opens the first search result with Enter", async () => {
    const user = userEvent.setup();
    render(<LatchProvider><App /></LatchProvider>);
    await user.keyboard("{Meta>}k{/Meta}");
    const search = screen.getByRole("textbox", { name: "Search Latch" });
    await user.type(search, "Explain error{Enter}");
    expect(screen.getByDisplayValue("Explain error")).toBeInTheDocument();
  });

  it("opens usable help from the question-mark button", async () => {
    const user = userEvent.setup();
    render(<LatchProvider><App /></LatchProvider>);
    await user.click(screen.getByRole("button", { name: "Help" }));
    expect(screen.getByRole("dialog", { name: "Using Latch Bar" })).toBeInTheDocument();
    expect(screen.getByText(/without a restart/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Settings" })).toBeInTheDocument();
  });

  it("collapses and restores the real sidebar", async () => {
    const user = userEvent.setup();
    const { container } = render(<LatchProvider><App /></LatchProvider>);
    expect(container.querySelector(".traffic-lights")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(container.querySelector(".app-shell")).toHaveClass("sidebar-collapsed");
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
    expect(localStorage.getItem("latch-sidebar-collapsed")).toBe("true");
  });

  it("toggles and persists Context Bar state", async () => {
    const user = userEvent.setup();
    render(<LatchProvider><App /></LatchProvider>);
    const toggle = screen.getByRole("button", { name: /Context Bar/ });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(JSON.parse(localStorage.getItem("latch-bar-state-v1")!).settings.contextBarEnabled).toBe(true);
  });
});
