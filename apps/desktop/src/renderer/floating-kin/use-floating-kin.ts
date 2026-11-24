import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  FloatingKinPreview,
  FloatingKinSummary,
  FloatingKinSummaryRequest
} from "@koed-labs/shared";
import type {
  FloatingKinActivityState,
  FloatingKinBridge,
  KinActivityBridge,
  KinSurfaceBridge,
  KinSummaryTarget
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
      preview: (input) => bridge.preview(input, revision),
      summarize: (input) => bridge.summarize(input, revision),
      latest: (target) => bridge.latest(target, revision),
      reopen: (target) => bridge.reopen(target, revision),
      cancel: () => bridge.cancel(revision)
    };
  }, [bridge, revision]);
}

const activePollMs = 3_000;
const quietPollMs = 10_000;

export type KinActivitySample = {
  activity: FloatingKinActivityState;
  at: number;
};

/**
 * Polls Kin activity. Until the first read for this source lands, it returns
 * a pending "starting" placeholder that callers should not present as status.
 */
export function useActivity(
  bridge: KinActivityBridge | undefined,
  visible = true,
  scopeKey: string | null = null
): KinActivitySample & { pending: boolean } {
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
  if (sample?.source === source)
    return { activity: sample.activity, at: sample.at, pending: false };
  const pending = Boolean(bridge && visible);
  return {
    activity: {
      state: bridge ? "starting" : "unavailable"
    } as FloatingKinActivityState,
    at: 0,
    pending
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

type SummaryView = {
  request: FloatingKinSummaryRequest;
  result: FloatingKinSummary | null;
  reopening?: boolean;
};

export function useSummary(bridge?: KinActivityBridge) {
  const [view, setView] = useState<SummaryView | null>(null);
  const running = useRef<{
    request: FloatingKinSummaryRequest;
    result: Promise<FloatingKinSummary>;
  } | null>(null);
  const cancelling = useRef(false);
  const [isCancelling, setIsCancelling] = useState(false);

  const run = async (
    request: FloatingKinSummaryRequest,
    read: () => Promise<FloatingKinSummary>,
    reopening = false
  ) => {
    if (running.current || cancelling.current) return;
    const pending = {
      request,
      result: Promise.resolve()
        .then(read)
        .catch(() => ({ status: "unavailable" as const }))
    };
    running.current = pending;
    setView({ request, result: null, reopening });
    const result = await pending.result;
    if (running.current !== pending) return;
    running.current = null;
    setView({ request, result, reopening });
  };
  const summarize = (request: FloatingKinSummaryRequest) => {
    if (bridge) return run(request, () => bridge.summarize(request));
  };
  const reopen = (
    target: KinSummaryTarget,
    action: FloatingKinSummaryRequest["action"]
  ) => {
    if (!bridge || (action === "project" && !target.projectId)) return;
    const request: FloatingKinSummaryRequest =
      action === "project" && target.projectId
        ? { sessionId: target.sessionId, projectId: target.projectId, action }
        : { sessionId: target.sessionId, action: "conversation" };
    return run(
      request,
      async () => {
        const stored = await bridge.reopen(target);
        return stored?.action === action
          ? stored.result
          : { status: "unavailable" };
      },
      true
    );
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

  return { view, summarize, reopen, cancel, isCancelling };
}

export function useCapturedPreview(
  bridge: KinActivityBridge | undefined,
  conversation:
    | { sessionId: string; projectId: string | null; lastActivityAt: string }
    | undefined
): FloatingKinPreview {
  const { sessionId, projectId, lastActivityAt } = conversation ?? {};
  const key = useMemo(
    () => ({ bridge, sessionId, projectId, lastActivityAt }),
    [bridge, sessionId, projectId, lastActivityAt]
  );
  const [sample, setSample] = useState<{
    key: typeof key;
    value: FloatingKinPreview;
  }>();
  useEffect(() => {
    if (!bridge || !sessionId) return;
    let current = true;
    void bridge
      .preview({ sessionId })
      .then((value) => {
        if (current) setSample({ key, value });
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [bridge, key, sessionId]);
  return sample?.key === key ? sample.value : null;
}

export function useLatestSummary(
  bridge: KinActivityBridge | undefined,
  sessionId: string | undefined,
  projectId: string | null,
  result: FloatingKinSummary | null | undefined
) {
  const key = useMemo(
    () => ({ bridge, sessionId, projectId, result }),
    [bridge, sessionId, projectId, result]
  );
  const [sample, setSample] = useState<{
    key: typeof key;
    action: FloatingKinSummaryRequest["action"] | null;
  }>();
  useEffect(() => {
    if (!bridge || !sessionId || result === null) return;
    let current = true;
    void bridge
      .latest({ sessionId, projectId })
      .then(({ action }) => {
        if (current) setSample({ key, action });
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [bridge, key, projectId, result, sessionId]);
  return sample?.key === key ? sample.action : null;
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
    const refreshSize = () => {
      size = "";
      resize();
    };
    window.addEventListener("resize", refreshSize);
    watchContent();
    return () => {
      window.removeEventListener("resize", refreshSize);
      observer.disconnect();
      mutations.disconnect();
      interactive.current = false;
      bridge.setInteractive(false);
    };
  }, [bridge, visible]);
  return { surface, setInteractive };
}
