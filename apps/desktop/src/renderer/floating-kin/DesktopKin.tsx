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
  sample,
  openAiModels
}: {
  bridge: KinActivityBridge;
  focusFallback: FocusFallback;
  sample: ReturnType<typeof useKinActivity>;
  openAiModels?: () => void;
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
      <KinActivityContent
        sample={sample}
        bridge={bridge}
        surface={surface}
        openAiModels={openAiModels}
      />
    </section>
  );
}

export function useDesktopKin(
  bridge: DesktopKinBridge | undefined,
  scopeKey: string | null = null,
  shellVisible = true,
  openAiModels?: () => void
) {
  const [presentation, setPresentation] = useState<KinPresentation | null>(
    null
  );
  useLayoutEffect(() => bridge?.onPresentation(setPresentation), [bridge]);
  useLayoutEffect(() => {
    if (openAiModels) return bridge?.onOpenAiModels(openAiModels);
  }, [bridge, openAiModels]);
  useLayoutEffect(() => {
    bridge?.setShellVisible(shellVisible);
  }, [bridge, shellVisible]);
  const placement = presentation?.placement;
  useLayoutEffect(() => {
    if (placement === "desktop" && presentation)
      bridge?.confirmPresentation(presentation.revision);
  }, [bridge, placement, presentation]);
  const activityBridge = useKinSurfaceActivity(bridge, presentation?.revision);
  const inApp =
    shellVisible && placement === "sidebar" && !presentation?.sidebarPending;
  const sample = useKinActivity(activityBridge, "sidebar", inApp, scopeKey);
  const dock: RenderDock = (focusFallback) =>
    inApp &&
    activityBridge &&
    (sample.conversations.length || sample.overflow) ? (
      <DesktopKinDock
        key={JSON.stringify([placement, presentation?.revision, scopeKey])}
        bridge={activityBridge}
        sample={sample}
        focusFallback={focusFallback}
        openAiModels={openAiModels}
      />
    ) : null;
  const avatar = (collapsed: boolean) =>
    inApp ? (
      <div
        className="fk-sidebar-avatar"
        data-collapsed={collapsed || undefined}
      >
        <StandaloneKin
          active={sample.recentCapture}
          placement="sidebar"
          size={collapsed ? 42 : 88}
        />
      </div>
    ) : null;
  return { dock, avatar };
}
