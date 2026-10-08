import { useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { createFocusTrap } from "focus-trap";
import { useEvent } from "../hooks/useEvent";
const stack: HTMLElement[] = [];
export function Modal({ children, label, className, onDismiss }: { children: ReactNode; label: string; className: string; onDismiss: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const dismiss = useEvent(onDismiss);
  useLayoutEffect(() => {
    const element = root.current!;
    stack.push(element);
    const previous = stack[stack.length - 2];
    const background = previous ?? document.getElementById("root");
    const wasInert = background?.inert ?? false;
    if (background) background.inert = true;
    const trap = createFocusTrap(element, {
      fallbackFocus: element, initialFocus: () => element.querySelector<HTMLElement>("[data-initial-focus]") || element.querySelector<HTMLElement>("input, button, textarea, select") || element, escapeDeactivates: false, clickOutsideDeactivates: false,
      returnFocusOnDeactivate: true,
      tabbableOptions: { displayCheck: import.meta.env.MODE === "test" ? "none" : "full" },
    });
    trap.activate();
    const backdrop = (event: MouseEvent) => { if (event.target === element && stack[stack.length - 1] === element) dismiss(); };
    element.addEventListener("mousedown", backdrop);
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && stack[stack.length - 1] === element) {
        event.preventDefault(); event.stopImmediatePropagation(); dismiss();
      }
    };
    window.addEventListener("keydown", key, true);
    return () => {
      element.removeEventListener("mousedown", backdrop);
      window.removeEventListener("keydown", key, true);
      stack.splice(stack.indexOf(element), 1);
      if (background) background.inert = wasInert;
      trap.deactivate();
    };
  }, [dismiss]);
  return createPortal(<div ref={root} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} className={className}>{children}</div>, document.body);
}
