import type { CodexAgent, NativeSelection } from "../domain";
export interface OutputActions {
  copy: (text: string) => Promise<void>;
  replace: (source: NativeSelection, text: string) => Promise<void>;
  studio: () => Promise<void>;
  explain: (reason: string) => void;
}
export async function performOutputAction(agent: CodexAgent, source: NativeSelection, text: string, replacementConsumed: boolean, actions: OutputActions) {
  if (!text) return;
  switch (agent.outputPolicy.mode) {
    case "copy": await actions.copy(text); break;
    case "open-studio": await actions.studio(); break;
    case "replace":
      if (source.replacementCapability === "none") actions.explain(source.replacementUnavailableReason || "The selected text is read-only. Copy the answer instead.");
      else if (agent.outputPolicy.allowReplace && !replacementConsumed) await actions.replace(source, text);
      break;
  }
}
