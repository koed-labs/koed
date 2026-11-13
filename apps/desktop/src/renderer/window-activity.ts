// While Koed is open but another app has focus, looping CSS animations
// (spinners, indeterminate progress, marquees) still make Chromium composite a
// frame on every display refresh. The GPU process then stays busy for as long
// as the window is on screen, which is hours during a first history import.
// Looping animations pause while the window is inactive and resume as soon as
// it has focus again. Finite animations keep running: popups and toasts wait
// for their exit animations to finish before they unmount.
export const WINDOW_INACTIVE_ATTRIBUTE = "data-window-inactive";

const loops = (animation: Animation) =>
  animation.effect?.getTiming().iterations === Infinity;

export function installWindowActivity(
  target: Window = window,
  root: HTMLElement = document.documentElement
): () => void {
  const paused = new Set<Animation>();
  const pause = (animations: Animation[]) => {
    for (const animation of animations) {
      if (!loops(animation) || animation.playState !== "running") continue;
      animation.pause();
      paused.add(animation);
    }
  };
  const deactivate = () => {
    root.setAttribute(WINDOW_INACTIVE_ATTRIBUTE, "");
    pause(target.document.getAnimations?.() ?? []);
  };
  const activate = () => {
    root.removeAttribute(WINDOW_INACTIVE_ATTRIBUTE);
    for (const animation of paused) animation.play();
    paused.clear();
  };
  // A spinner that mounts while the window is inactive starts paused too.
  const onAnimationStart = (event: Event) => {
    if (!root.hasAttribute(WINDOW_INACTIVE_ATTRIBUTE)) return;
    const element = event.target;
    if (element instanceof Element) pause(element.getAnimations?.() ?? []);
  };
  target.addEventListener("blur", deactivate);
  target.addEventListener("focus", activate);
  target.document.addEventListener("animationstart", onAnimationStart, true);
  if (target.document.hasFocus()) activate();
  else deactivate();
  return () => {
    target.removeEventListener("blur", deactivate);
    target.removeEventListener("focus", activate);
    target.document.removeEventListener(
      "animationstart",
      onAnimationStart,
      true
    );
    activate();
  };
}
