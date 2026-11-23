import {
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject
} from "react";
import type {
  DesktopKinBridge,
  KinPresentation,
  KinActivityBridge
} from "../../ipc/floating-kin-protocol.js";
import {
  KinActivityContent,
  StandaloneKin,
  useKinActivity
} from "./FloatingKin.js";
import { useKinSurfaceActivity } from "./use-floating-kin.js";

type FocusFallback = RefObject<HTMLInputElement | null>;
type RenderDock = (focusFallback: FocusFallback) => ReactNode;

function DesktopKinDock({
  bridge,
  focusFallback,
  sample
}: {
  bridge: KinActivityBridge;
  focusFallback: FocusFallback;
  sample: ReturnType<typeof useKinActivity>;
}) {
  const surface = useRef<HTMLElement>(null);
  useLayoutEffect(
    () => () => {
      if (surface.current?.contains(document.activeElement))
        focusFallback.current?.focus({ preventScroll: true });
    },
    [focusFallback]
  );
  return (
    <section
      className="fk-surface"
      data-fk-placement="sidebar"
      aria-label="Chief of Staff activity"
      ref={surface}
      tabIndex={-1}
    >
      <KinActivityContent sample={sample} bridge={bridge} surface={surface} />
    </section>
  );
}

export function useDesktopKin(
  bridge: DesktopKinBridge | undefined,
  home: boolean,
  scopeKey: string | null = null,
  shellVisible = true
) {
  const [presentation, setPresentation] = useState<KinPresentation | null>(
    null
  );
  useLayoutEffect(() => bridge?.onPresentation(setPresentation), [bridge]);
  useLayoutEffect(() => {
    bridge?.setHomeVisible(home);
  }, [bridge, home]);
  const placement = presentation?.placement;
  useLayoutEffect(() => {
    if (placement === "desktop" && presentation)
      bridge?.confirmPresentation(presentation.revision);
  }, [bridge, placement, presentation]);
  const activityBridge = useKinSurfaceActivity(bridge, presentation?.revision);
  const inApp = shellVisible && placement === (home ? "home" : "sidebar");
  const sample = useKinActivity(activityBridge, inApp, scopeKey);
  const dock: RenderDock = (focusFallback) =>
    inApp &&
    activityBridge &&
    (sample.conversations.length || sample.overflow) ? (
      <DesktopKinDock
        key={JSON.stringify([placement, presentation?.revision, scopeKey])}
        bridge={activityBridge}
        sample={sample}
        focusFallback={focusFallback}
      />
    ) : null;
  const corner =
    inApp && !presentation?.homePending ? (
      <div className="fk-window-corner" data-fk-placement="window">
        <StandaloneKin active={sample.recentCapture} placement="window" />
      </div>
    ) : null;
  return { dock, corner };
}
