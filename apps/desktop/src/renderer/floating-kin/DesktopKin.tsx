import { useLayoutEffect, useRef, useState, type RefObject } from "react";
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

function DesktopKinDock(props: {
  bridge: KinActivityBridge;
  avatar: boolean;
  focusFallback: FocusFallback;
}) {
  const sample = useKinActivity(props.bridge);
  if (!props.avatar && !sample.conversations.length && !sample.overflow)
    return null;
  return <VisibleKinDock {...props} sample={sample} />;
}

function VisibleKinDock({
  bridge,
  avatar,
  focusFallback,
  sample
}: {
  bridge: KinActivityBridge;
  avatar: boolean;
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
      {avatar && (
        <StandaloneKin active={sample.recentCapture} placement="sidebar" />
      )}
      <KinActivityContent sample={sample} bridge={bridge} surface={surface} />
    </section>
  );
}

export function useDesktopKin(
  bridge: DesktopKinBridge | undefined,
  home: boolean,
  scopeKey: string | null = null
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
  const dock = (focusFallback: FocusFallback) =>
    activityBridge &&
    presentation &&
    placement === (home ? "home" : "sidebar") ? (
      <DesktopKinDock
        key={`${placement}:${presentation.revision}:${scopeKey}`}
        bridge={activityBridge}
        avatar={placement === "sidebar"}
        focusFallback={focusFallback}
      />
    ) : null;
  const showHomeAvatar =
    home && presentation?.placement === "home" && !presentation.homePending;
  return { showHomeAvatar, dock };
}
