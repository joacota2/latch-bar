import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { readTransientResult, subscribeTransientResult, type TransientSnapshot } from "../services/transientResults";
import { useLatch } from "./LatchStore";
const Context = createContext<TransientSnapshot>({ revision: 0, result: null });
export function TransientResultProvider({ children }: { children: ReactNode }) {
  const { resetEpoch, setActiveNav, notify } = useLatch();
  const [snapshot, setSnapshot] = useState<TransientSnapshot>({ revision: 0, result: null });
  useEffect(() => {
    let disposed = false;
    const accept = (next: TransientSnapshot) => {
      if (!disposed && next) {
        setSnapshot((current) => next.revision >= current.revision ? next : current);
        if (next.result && next.result.epoch === resetEpoch && !next.result.acknowledged) setActiveNav("runs");
      }
    };
    const subscription = subscribeTransientResult(accept);
    void subscription.then(() => readTransientResult()).then(accept).catch(() => { if (!disposed) notify("Could not read the temporary result. Retry from the Context Bar."); });
    return () => { disposed = true; void subscription.then((dispose) => dispose()).catch(() => undefined); };
  }, [notify, resetEpoch, setActiveNav]);
  return <Context.Provider value={{ ...snapshot, result: snapshot.result?.epoch === resetEpoch ? snapshot.result : null }}>{children}</Context.Provider>;
}
export const useTransientResult = () => useContext(Context).result;
