import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexRunError } from "./CodexRunError";
import { codexFailure } from "../services/codexErrors";

const mocks = vi.hoisted(() => ({ status: vi.fn(), scan: vi.fn(), open: vi.fn() }));
vi.mock("../services/runtime", () => ({ getRuntimeStatus: mocks.status, scanCodexEnvironment: mocks.scan }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.open }));
const unsupported = "The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account.";
const raw = JSON.stringify({ type: "error", status: 400, error: { type: "invalid_request_error", message: unsupported } });
const oldRuntime = { available: true, version: "0.146.1", path: "/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.status.mockResolvedValue(oldRuntime);
  mocks.scan.mockResolvedValue({ account: { requiresOpenaiAuth: true, signedIn: true } });
  mocks.open.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("Codex model recovery", () => {
  it("distinguishes an explicit update requirement from ambiguous account rejection", () => {
    expect(codexFailure(raw)).toMatchObject({ title: "Codex may need an update", modelCompatibility: true, message: unsupported });
    expect(codexFailure("The 'gpt-6-astra' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.")).toMatchObject({ title: "Update Codex to continue", modelCompatibility: true });
    for (const message of ["Rate limit exceeded", "Your account has no credits", "Tool execution failed", "{malformed JSON", "null"]) {
      expect(codexFailure(message)).toMatchObject({ title: "Run failed", modelCompatibility: false, message });
    }
  });

  it.each(["Codex", "ChatGPT"])("directs a bundled runtime to the %s app and keeps JSON in details", async (app) => {
    mocks.status.mockResolvedValue({ ...oldRuntime, path: `/Users/test/Applications/${app}.app/Contents/Resources/codex` });
    render(<CodexRunError error={raw} />);
    expect(await screen.findByText(new RegExp(`Open the ${app} app`))).toBeInTheDocument();
    const detail = screen.getByText(raw).closest("details");
    expect(detail).not.toHaveAttribute("open");
    await userEvent.click(screen.getByRole("button", { name: "Update instructions" }));
    expect(mocks.open).toHaveBeenCalledWith("https://help.openai.com/en/articles/20001354-gpt-6-and-other-models-in-chatgpt");
  });

  it("does not tell a standalone CLI user to update the desktop app", async () => {
    mocks.status.mockResolvedValue({ ...oldRuntime, path: "/opt/homebrew/bin/codex" });
    render(<CodexRunError error={raw} />);
    expect(await screen.findByText(/separately installed Codex CLI/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Update instructions" }));
    expect(mocks.open).toHaveBeenCalledWith("https://developers.openai.com/codex/cli");
  });

  it("explains an explicit runtime override instead of suggesting an app update", async () => {
    mocks.status.mockResolvedValue({ ...oldRuntime, path: "/Users/test/.local/bin/codex", source: "override", diagnostics: [{ path: "/Users/test/.local/bin/codex", detail: "CODEX_BIN override: Codex 0.144.6" }] });
    render(<CodexRunError error={raw} />);
    expect(await screen.findByText(/CODEX_BIN is forcing/)).toBeInTheDocument();
    expect(screen.getByText(/CODEX_BIN overrides automatic runtime selection/)).toBeInTheDocument();
  });

  it("recognizes a renamed desktop app and exposes failed detection attempts", async () => {
    mocks.status.mockResolvedValue({ ...oldRuntime, path: "/Volumes/Apps/My assistant.app/Contents/Resources/codex-cli/bin/codex", source: "desktop-app", diagnostics: [{ path: "/Applications/ChatGPT.app/Contents/Resources/codex", detail: "Not found" }] });
    render(<CodexRunError error={raw} />);
    expect(await screen.findByText(/Open your Codex or ChatGPT app/)).toBeInTheDocument();
    expect(screen.getByText("Runtime detection")).toBeInTheDocument();
    expect(screen.getByText(/Not found/)).toBeInTheDocument();
    expect(screen.queryByText(/separately installed Codex CLI/)).not.toBeInTheDocument();
  });

  it("checks the failed agent's profile and workspace without claiming model access is fixed", async () => {
    render(<CodexRunError error={raw} workspacePath="/projects/example" profile="work" />);
    await screen.findByText("Using Codex 0.146.1");
    mocks.status.mockResolvedValue({ ...oldRuntime, version: "0.162.0-alpha.2" });
    await userEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Detected Codex 0.162.0-alpha.2");
    expect(screen.getByRole("status")).toHaveTextContent("run your agent again to test model access");
    expect(mocks.scan).toHaveBeenCalledWith("/projects/example", "work");
  });

  it("reports an unchanged runtime and failed checks without losing the original error", async () => {
    render(<CodexRunError error={raw} />);
    await screen.findByText("Using Codex 0.146.1");
    await userEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Still using Codex 0.146.1");
    mocks.scan.mockRejectedValueOnce(new Error("offline"));
    await userEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Could not check Codex"));
    expect(screen.getByText(raw)).toBeInTheDocument();
  });

  it("offers a retry after checking but only runs when the user chooses it", async () => {
    const retry = vi.fn();
    render(<CodexRunError error={raw} onRetry={retry} />);
    await screen.findByText("Using Codex 0.146.1");
    expect(screen.queryByRole("button", { name: "Run again" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByRole("button", { name: "Run again" })).toBeInTheDocument();
    expect(retry).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Run again" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("handles missing installations and signed-out accounts", async () => {
    render(<CodexRunError error={raw} />);
    await screen.findByText("Using Codex 0.146.1");
    mocks.status.mockResolvedValueOnce({ ...oldRuntime, available: false });
    await userEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Codex was not found");
    expect(mocks.scan).not.toHaveBeenCalled();
    mocks.scan.mockResolvedValueOnce({ account: { requiresOpenaiAuth: true, signedIn: false } });
    await userEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Sign in to Codex"));
  });

  it("leaves unrelated errors readable without update actions", () => {
    render(<CodexRunError error="Connection lost" />);
    expect(screen.getByText("Connection lost")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check again" })).not.toBeInTheDocument();
    expect(mocks.status).not.toHaveBeenCalled();
  });
});
