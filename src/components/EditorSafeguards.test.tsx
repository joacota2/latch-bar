import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { LatchProvider, useLatch } from "../store/LatchStore";
import { AgentEditor } from "./AgentEditor";
import { seedAgents } from "../data/seed";
let store: ReturnType<typeof useLatch>;
function Harness() {
  store = useLatch();
  return <AgentEditor />;
}
async function mount() {
  render(
    <LatchProvider>
      <Harness />
    </LatchProvider>,
  );
  await waitFor(() => expect(store.ready).toBe(true));
  act(() => store.setSelectedAgentId(seedAgents[0].id));
  await screen.findByRole("dialog", { name: "Edit agent" });
}
afterEach(() => {
  cleanup();
  localStorage.clear();
});
it("protects dirty JSON on close and applies it when Save is chosen", async () => {
  const user = userEvent.setup();
  await mount();
  await user.click(screen.getByRole("button", { name: "JSON" }));
  const json = screen.getByRole("textbox", {
    name: "Agent JSON configuration",
  });
  const config = JSON.parse((json as HTMLTextAreaElement).value);
  config.agent.name = "JSON draft";
  await user.clear(json);
  await user.paste(JSON.stringify(config));
  await user.click(screen.getByRole("button", { name: "Close agent editor" }));
  await screen.findByRole("dialog", { name: "Unsaved changes" });
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Edit agent" }),
    ).not.toBeInTheDocument(),
  );
  expect(store.agents[0].name).toBe("JSON draft");
});
it("keeps invalid JSON and failed writes visible and protects switching agents", async () => {
  const user = userEvent.setup();
  await mount();
  await user.click(screen.getByRole("button", { name: "JSON" }));
  const json = screen.getByRole("textbox", {
    name: "Agent JSON configuration",
  });
  await user.clear(json);
  await user.paste("invalid JSON");
  act(() => store.setSelectedAgentId(seedAgents[1].id));
  await screen.findByRole("dialog", { name: "Unsaved changes" });
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(screen.getAllByText(/not valid JSON/).length).toBeGreaterThan(0);
  expect(store.selectedAgentId).toBe(seedAgents[0].id);
  await user.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(json).toHaveValue("invalid JSON");
});
it("retains local edits when the saved revision changes and requires explicit resolution", async () => {
  const user = userEvent.setup();
  await mount();
  const name = screen.getByRole("textbox", { name: "Name" });
  await user.clear(name);
  await user.type(name, "My draft");
  await act(async () => {
    await store.updateAgent({ ...store.agents[0], name: "Remote edit" });
  });
  expect(name).toHaveValue("My draft");
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  expect(store.agents[0].name).toBe("Remote edit");
  await user.click(
    screen.getByRole("button", { name: "Overwrite with my draft" }),
  );
  await waitFor(() => expect(store.agents[0].name).toBe("My draft"));
});
it("routes the Studio close request through the same dirty-draft decision", async () => {
  const user = userEvent.setup();
  await mount();
  const name = screen.getByRole("textbox", { name: "Name" });
  await user.clear(name);
  await user.type(name, "Unsaved");
  let close!: Promise<boolean>;
  act(() => {
    close = store.requestCloseEditor();
  });
  await screen.findByRole("dialog", { name: "Unsaved changes" });
  await user.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(await close).toBe(false);
  expect(name).toHaveValue("Unsaved");
  act(() => {
    close = store.requestCloseEditor();
  });
  await user.click(await screen.findByRole("button", { name: "Discard" }));
  expect(await close).toBe(true);
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Edit agent" }),
    ).not.toBeInTheDocument(),
  );
});
