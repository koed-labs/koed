import { useEffect, useRef, type RefObject } from "react";

// Keep keyboard focus inside the active settings dialog, including confirmations.
export function useSettingsFocus(
  sheet: RefObject<HTMLDivElement | null>,
  confirming: boolean
) {
  const previous = useRef(
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
  );
  useEffect(() => {
    const root = sheet.current;
    if (!root) return;
    const scope =
      root.querySelector<HTMLElement>('[role="alertdialog"]') ?? root;
    if (!scope.contains(document.activeElement))
      scope
        .querySelector<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]'
        )
        ?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const targets = [
        ...scope.querySelectorAll<HTMLElement>(
          "button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex]"
        )
      ].filter(
        (element) =>
          element.tabIndex >= 0 &&
          !element.hidden &&
          getComputedStyle(element).display !== "none"
      );
      const first = targets[0],
        last = targets.at(-1);
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      if (
        !scope.contains(document.activeElement) ||
        (!event.shiftKey && document.activeElement === last)
      ) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
    };
    root.addEventListener("keydown", trap);
    return () => root.removeEventListener("keydown", trap);
  }, [sheet, confirming]);
  useEffect(
    () => () => {
      if (previous.current?.isConnected) previous.current.focus();
    },
    []
  );
}
