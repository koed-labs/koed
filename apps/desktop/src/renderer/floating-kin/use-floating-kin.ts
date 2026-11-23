import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  FloatingKinSummary,
  FloatingKinSummaryRequest
} from "@koed-labs/shared";
import type {
  FloatingKinActivityState,
  FloatingKinBridge,
  KinActivityBridge,
  KinSurfaceBridge
} from "../../ipc/floating-kin-protocol.js";

export function useKinSurfaceActivity(
  bridge?: KinSurfaceBridge,
  revision?: number
) {
  return useMemo<KinActivityBridge | undefined>(() => {
    if (!bridge || (bridge.onPresentation && revision === undefined)) return;
    if (revision === undefined) return bridge;
    return {
      activity: () => bridge.activity(revision),
      summarize: (input) => bridge.summarize(input, revision),
      cancel: () => bridge.cancel(revision)
    };
  }, [bridge, revision]);
}

const activePollMs = 3_000;
const quietPollMs = 10_000;

export function useActivity(
  bridge?: KinActivityBridge,
  visible = true,
  scopeKey: string | null = null
) {
  const source = useMemo(
    () => ({ bridge, visible, scopeKey }),
    [bridge, visible, scopeKey]
  );
  const [sample, setSample] = useState<{
    source: typeof source;
    activity: FloatingKinActivityState;
    at: number;
  } | null>(null);
  const inFlight = useRef<{
    source: typeof source;
    read: Promise<FloatingKinActivityState>;
  } | null>(null);
  useEffect(() => {
    const { bridge, visible } = source;
    if (!bridge || !visible) return;
    let closed = false;
    let polling = false;
    let timer: number | undefined;
    const poll = async () => {
      if (closed || polling || document.hidden) return;
      polling = true;
      let activity: FloatingKinActivityState;
      const read =
        inFlight.current?.source === source
          ? inFlight.current.read
          : Promise.resolve().then(() => bridge.activity());
      inFlight.current = { source, read };
      try {
        activity = await read;
      } catch {
        activity = { state: "unavailable" };
      } finally {
        if (inFlight.current?.read === read) inFlight.current = null;
        polling = false;
      }
      if (closed || document.hidden) return;
      setSample({ source, activity, at: Date.now() });
      const active =
        activity.state === "starting" ||
        (activity.state === "running" && activity.conversations.length > 0);
      timer = window.setTimeout(
        () => void poll(),
        active ? activePollMs : quietPollMs
      );
    };
    const onVisibility = () => {
      window.clearTimeout(timer);
      if (!document.hidden) void poll();
    };
    document.addEventListener("visibilitychange", onVisibility);
    void poll();
    return () => {
      closed = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [source]);
  return sample?.source === source
    ? sample
    : {
        activity: {
          state: bridge ? "starting" : "unavailable"
        } as FloatingKinActivityState,
        at: 0
      };
}

export function useCaptureWake(deadline: number, sampledAt: number) {
  const [expiredDeadline, setExpiredDeadline] = useState(0);
  useEffect(() => {
    if (!deadline) return;
    const timer = window.setTimeout(
      () => setExpiredDeadline(deadline),
      Math.max(0, deadline - Date.now())
    );
    return () => window.clearTimeout(timer);
  }, [deadline]);
  return sampledAt < deadline && expiredDeadline !== deadline;
}

export function useMainWindowFocus(bridge?: FloatingKinBridge) {
  const [focused, setFocused] = useState(false);
  useEffect(() => bridge?.onMainWindowFocus(setFocused), [bridge]);
  return focused;
}

type SummaryView = {
  request: FloatingKinSummaryRequest;
  result: FloatingKinSummary | null;
};

export function useSummary(bridge?: KinActivityBridge) {
  const [view, setView] = useState<SummaryView | null>(null);
  const running = useRef<{
    request: FloatingKinSummaryRequest;
    result: Promise<FloatingKinSummary>;
  } | null>(null);
  const cancelling = useRef(false);
  const [isCancelling, setIsCancelling] = useState(false);

  const summarize = async (request: FloatingKinSummaryRequest) => {
    if (!bridge || running.current || cancelling.current) return;
    const pending = {
      request,
      result: Promise.resolve()
        .then(() => bridge.summarize(request))
        .catch(() => ({ status: "unavailable" as const }))
    };
    running.current = pending;
    setView({ request, result: null });
    const result = await pending.result;
    if (running.current !== pending) return;
    running.current = null;
    setView({ request, result });
  };

  const cancel = useCallback(
    async (dismiss = false) => {
      const pending = running.current;
      if (dismiss) setView(null);
      if (!bridge || !pending) return;
      running.current = null;
      cancelling.current = true;
      setIsCancelling(true);
      const [cancellation] = await Promise.allSettled([
        Promise.resolve().then(() => bridge.cancel()),
        pending.result
      ]);
      cancelling.current = false;
      setIsCancelling(false);
      if (!dismiss) {
        const { request } = pending;
        const status =
          cancellation.status === "fulfilled" ? "cancelled" : "unavailable";
        setView((current) =>
          current?.request === request
            ? { request, result: { status } }
            : current
        );
      }
    },
    [bridge]
  );

  useEffect(
    () => () => {
      if (!running.current) return;
      running.current = null;
      void bridge?.cancel().catch(() => undefined);
    },
    [bridge]
  );

  return { view, summarize, cancel, isCancelling };
}

const pixels = (value: string) => Number.parseFloat(value) || 0;
const elementHeight = (element: Element) =>
  element.getBoundingClientRect().height;

// Measure the layout's preferred height independently of the native viewport.
function preferredOverlayHeight(
  node: HTMLElement,
  summary: HTMLDivElement | null
) {
  const style = getComputedStyle(node);
  const children = Array.from(node.children);
  const body = summary?.parentElement;
  const panel = body?.parentElement;
  const header = body?.previousElementSibling;
  const contentHeight = children.reduce((height, child) => {
    if (child !== panel || !header || !body || !summary)
      return height + elementHeight(child);
    const panelStyle = getComputedStyle(panel);
    const limit = pixels(getComputedStyle(body).maxHeight) || Infinity;
    return (
      height +
      elementHeight(header) +
      Math.min(limit, elementHeight(summary)) +
      pixels(panelStyle.borderTopWidth) +
      pixels(panelStyle.borderBottomWidth)
    );
  }, 0);
  return (
    contentHeight +
    pixels(style.paddingTop) +
    pixels(style.paddingBottom) +
    pixels(style.rowGap) * Math.max(0, children.length - 1)
  );
}

export function useOverlayWindow(bridge?: FloatingKinBridge, visible = true) {
  const surface = useRef<HTMLElement>(null);
  const interactive = useRef(false);
  const setInteractive = (value: boolean) => {
    if (interactive.current === value) return;
    interactive.current = value;
    bridge?.setInteractive(value);
  };
  useEffect(() => {
    const node = surface.current;
    if (!visible) interactive.current = false;
    if (!bridge || !node || !visible) return;
    let size = "";
    let summary: HTMLDivElement | null = null;
    const resize = () => {
      const width = Math.ceil(node.getBoundingClientRect().width);
      const height = Math.ceil(preferredOverlayHeight(node, summary));
      if (!width || !height || size === `${width}:${height}`) return;
      size = `${width}:${height}`;
      bridge.setSize({ width, height });
    };
    const observer = new ResizeObserver(resize);
    const watchContent = () => {
      observer.disconnect();
      observer.observe(node);
      for (const child of node.children) observer.observe(child);
      summary = node.querySelector<HTMLDivElement>(".fk-body-content");
      if (summary) observer.observe(summary);
      resize();
    };
    const mutations = new MutationObserver(watchContent);
    mutations.observe(node, { childList: true });
    watchContent();
    return () => {
      observer.disconnect();
      mutations.disconnect();
      interactive.current = false;
      bridge.setInteractive(false);
    };
  }, [bridge, visible]);
  return { surface, setInteractive };
}
