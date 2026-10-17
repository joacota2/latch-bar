import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import { codexFailure, codexUpdateHelp } from "../services/codexErrors";
import {
  getRuntimeStatus,
  scanCodexEnvironment,
  type RuntimeStatus,
} from "../services/runtime";
import { RuntimeDetection } from "./RuntimeDetection";

export function CodexRunError({
  error,
  workspacePath,
  profile,
  onRetry,
}: {
  error: string;
  workspacePath?: string;
  profile?: string;
  onRetry?: () => void;
}) {
  const failure = codexFailure(error);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [checked, setChecked] = useState(false);
  const request = useRef(0);
  useEffect(() => {
    const id = ++request.current;
    if (failure.modelCompatibility) {
      void getRuntimeStatus()
        .then((status) => {
          if (request.current === id) setRuntime(status);
        })
        .catch(() => {
          if (request.current === id)
            setFeedback(
              "Could not identify your Codex installation. You can still follow the update instructions.",
            );
        });
    }
    return () => {
      request.current += 1;
    };
  }, [failure.modelCompatibility]);
  const help = codexUpdateHelp(runtime);
  const checkAgain = async () => {
    const id = ++request.current;
    setChecking(true);
    setChecked(false);
    setFeedback("");
    try {
      const status = await getRuntimeStatus(true);
      if (request.current !== id) return;
      const previous = runtime;
      setRuntime(status);
      if (!status.available) {
        setFeedback(
          "Codex was not found. Finish installing the update, then check again.",
        );
        return;
      }
      const environment = await scanCodexEnvironment(workspacePath, profile);
      if (request.current !== id) return;
      if (!environment) throw new Error("Could not connect to Codex.");
      if (
        environment.account.requiresOpenaiAuth &&
        !environment.account.signedIn
      ) {
        setFeedback("Sign in to Codex, then check again.");
        return;
      }
      const changed =
        previous &&
        (previous.version !== status.version || previous.path !== status.path);
      setChecked(true);
      setFeedback(
        `${changed || !previous ? "Detected" : "Still using"} Codex ${status.version}. ${onRetry ? "Choose Run again" : "Close this panel and run your agent again"} to test model access. If it still fails, check your account or workspace model access in Codex.`,
      );
    } catch {
      if (request.current === id)
        setFeedback(
          "Could not check Codex. Finish the update and try again, or check Settings → Codex in Latch.",
        );
    } finally {
      if (request.current === id) setChecking(false);
    }
  };
  const openInstructions = async () => {
    try {
      await openUrl(help.url);
    } catch {
      setFeedback(
        "Could not open the update instructions. Open your Codex installation and check for updates.",
      );
    }
  };

  return (
    <div className="context-error-detail">
      {failure.modelCompatibility ? (
        <div className="codex-recovery">
          <p>{failure.explanation}</p>
          <p>{help.instruction}</p>
          {runtime?.available && (
            <p className="codex-recovery-version">
              Using Codex {runtime.version}
            </p>
          )}
          <div className="codex-recovery-actions">
            <button
              type="button"
              className="result-button primary"
              onClick={() => void openInstructions()}
            >
              Update instructions
            </button>
            <button
              type="button"
              className="result-button"
              disabled={checking}
              onClick={() => void checkAgain()}
            >
              {checking ? "Checking…" : "Check again"}
            </button>
            {checked && onRetry && (
              <button type="button" className="result-button" onClick={onRetry}>
                Run again
              </button>
            )}
          </div>
          {feedback && <p role="status">{feedback}</p>}
        </div>
      ) : (
        <p>{failure.message}</p>
      )}
      {(failure.modelCompatibility || failure.message !== error) && (
        <details className="codex-error-technical">
          <summary>Technical details</summary>
          {runtime?.path && <p>{runtime.path}</p>}
          <RuntimeDetection runtime={runtime} />
          <pre>{error}</pre>
        </details>
      )}
    </div>
  );
}
