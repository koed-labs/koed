import type { KinPlacement } from "../ipc/floating-kin-protocol.js";

export const kinExitTimeoutMs = 750;

export function resolveKinPlacement({
  floatingEnabled,
  mainFocused
}: {
  floatingEnabled: boolean;
  mainFocused: boolean;
}): KinPlacement {
  return floatingEnabled && !mainFocused ? "desktop" : "sidebar";
}

export function createKinHandoff({
  show,
  hide,
  slide,
  reducedMotion = () => false
}: {
  show: () => void;
  hide: () => void;
  slide: (visible: boolean) => void;
  reducedMotion?: () => boolean;
}) {
  let visible: boolean | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let exiting: number | undefined;
  const cancelExit = () => {
    clearTimeout(timer);
    exiting = undefined;
  };
  const completeExit = (revision: number) => {
    if (exiting !== revision) return;
    cancelExit();
    hide();
  };
  return {
    completeExit,
    setVisible(next: boolean, revision: number) {
      if (visible === next) return;
      cancelExit();
      const animate = visible === true && !reducedMotion();
      visible = next;
      if (next) show();
      slide(next);
      if (!next) {
        if (animate) {
          exiting = revision;
          timer = setTimeout(() => completeExit(revision), kinExitTimeoutMs);
        } else hide();
      }
    },
    dispose() {
      cancelExit();
      visible = undefined;
    }
  };
}
