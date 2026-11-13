// While Koed is open but another app has focus, looping CSS animations
// (spinners, indeterminate progress, marquees) still make Chromium composite a
// frame on every display refresh. The GPU process then stays busy for as long
// as the window is on screen, which is hours during a first history import.
// index.css pauses looping animations while this attribute is present, and
// they resume as soon as the window has focus again.
export const WINDOW_INACTIVE_ATTRIBUTE = "data-window-inactive";

export function installWindowActivity(
  target: Window = window,
  root: HTMLElement = document.documentElement
): () => void {
  const sync = () => {
    if (target.document.hasFocus())
      root.removeAttribute(WINDOW_INACTIVE_ATTRIBUTE);
    else root.setAttribute(WINDOW_INACTIVE_ATTRIBUTE, "");
  };
  const onBlur = () => root.setAttribute(WINDOW_INACTIVE_ATTRIBUTE, "");
  const onFocus = () => root.removeAttribute(WINDOW_INACTIVE_ATTRIBUTE);
  target.addEventListener("blur", onBlur);
  target.addEventListener("focus", onFocus);
  sync();
  return () => {
    target.removeEventListener("blur", onBlur);
    target.removeEventListener("focus", onFocus);
    root.removeAttribute(WINDOW_INACTIVE_ATTRIBUTE);
  };
}
