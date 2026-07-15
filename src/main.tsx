import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { LatchProvider } from "./store/LatchStore";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LatchProvider>
      <App />
    </LatchProvider>
  </StrictMode>,
);
