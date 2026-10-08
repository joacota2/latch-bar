import { useCallback, useRef, useState } from "react";
import {
  contextSessionReducer,
  initialSession,
  type ContextSession,
  type SessionAction,
} from "../services/contextSession";
/** The ref is the controller's authoritative snapshot, including between batched events. */
export function useContextSession() {
  const snapshot = useRef(initialSession);
  const [session, render] = useState(initialSession);
  const dispatch = useCallback((action: SessionAction) => {
    const next = contextSessionReducer(snapshot.current, action);
    if (next !== snapshot.current) {
      snapshot.current = next;
      render(next);
    }
  }, []);
  const patch = useCallback(
    (patch: Partial<Omit<ContextSession, "generation">>) =>
      dispatch({
        type: "patch",
        generation: snapshot.current.generation,
        patch,
      }),
    [dispatch],
  );
  return { session, snapshot, dispatch, patch };
}
