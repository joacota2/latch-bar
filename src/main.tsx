import "wicg-inert";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ContextBarWindow } from "./components/ContextBarWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "./services/runtime";
import { LatchProvider } from "./store/LatchStore";
import "./styles.css";

const contextWindow = isTauri() && getCurrentWindow().label === "context-bar";
document.body.classList.toggle("context-window", contextWindow);
document.documentElement.classList.toggle("context-window", contextWindow);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LatchProvider>
      {contextWindow ? <ContextBarWindow /> : <App />}
    </LatchProvider>
  </StrictMode>,
);
