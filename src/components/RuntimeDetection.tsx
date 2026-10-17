import type { RuntimeStatus } from "../services/runtime";

export function RuntimeDetection({
  runtime,
}: {
  runtime: RuntimeStatus | null;
}) {
  if (!runtime?.diagnostics?.length) return null;
  return (
    <details className="runtime-detection">
      <summary>Runtime detection</summary>
      <p>
        {runtime.source === "override"
          ? "CODEX_BIN overrides automatic runtime selection. Update or remove that override to use an app's bundled runtime."
          : runtime.source === "desktop-app"
            ? "Using the newest working runtime found in a Codex or ChatGPT app."
            : runtime.available
              ? "No working app runtime was found. Using the separately installed CLI."
              : "No working Codex runtime was found."}
      </p>
      <ul>
        {runtime.diagnostics.map((probe, index) => (
          <li key={`${probe.path}-${index}`}>
            <code>{probe.path}</code>: {probe.detail}
          </li>
        ))}
      </ul>
    </details>
  );
}
