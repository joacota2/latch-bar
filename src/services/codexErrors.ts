import type { RuntimeStatus } from "./runtime";

/** Codex sometimes wraps a provider JSON error inside its message string. */
export function codexErrorMessage(raw: string): string {
  let message = raw;
  for (let depth = 0; depth < 4; depth += 1) {
    try {
      const value = JSON.parse(message);
      const nested = value?.error?.message ?? value?.message;
      if (typeof nested !== "string" || !nested.trim() || nested === message) break;
      message = nested;
    } catch { break; }
  }
  return message;
}

export function codexFailure(raw: string) {
  const message = codexErrorMessage(raw);
  const needsUpdate = /model .{0,100}requires a newer version of Codex/i.test(message);
  const unsupported = /model is not supported when using Codex with a ChatGPT account/i.test(message);
  return {
    message,
    modelCompatibility: needsUpdate || unsupported,
    title: needsUpdate ? "Update Codex to continue" : unsupported ? "Codex may need an update" : "Run failed",
    explanation: needsUpdate
      ? "This model requires a newer version of Codex."
      : "Codex could not use this model. An older version can cause this error; account or workspace access can also affect availability.",
  };
}

export function codexUpdateHelp(runtime: RuntimeStatus | null) {
  const app = runtime?.path?.match(/\/(Codex|ChatGPT)\.app\/Contents\//)?.[1];
  if (app) return {
    instruction: `Open the ${app} app and choose Check for Updates from its menu. Install the update, then return here and check again.`,
    url: "https://help.openai.com/en/articles/20001354-gpt-6-and-other-models-in-chatgpt",
  };
  if (runtime?.path) return {
    instruction: "Latch is using a separately installed Codex CLI. Update it using the package manager you installed it with, then check again.",
    url: "https://developers.openai.com/codex/cli",
  };
  return {
    instruction: "Update your Codex or ChatGPT app, or your Codex CLI if installed separately. Then check again.",
    url: "https://help.openai.com/en/articles/20001354-gpt-6-and-other-models-in-chatgpt",
  };
}
