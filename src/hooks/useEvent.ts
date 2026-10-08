import { useCallback, useLayoutEffect, useRef } from "react";
// Stable subscription callback, refreshed after each committed render.
export function useEvent<T extends (...args: never[]) => unknown>(
  callback: T,
): T {
  const current = useRef(callback);
  useLayoutEffect(() => {
    current.current = callback;
  });
  return useCallback(
    ((...args: Parameters<T>) => current.current(...args)) as T,
    [],
  );
}
