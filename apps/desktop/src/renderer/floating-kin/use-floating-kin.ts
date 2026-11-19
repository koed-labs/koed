import { useCallback, useEffect, useRef, useState } from "react";
import type {
  FloatingKinSummary,
  FloatingKinSummaryRequest
} from "@koed-labs/shared";
import type {
  FloatingKinActivityState,
  FloatingKinBridge
} from "../../ipc/floating-kin-protocol.js";

const activePollMs = 3_000;
const quietPollMs = 10_000;

export function useActivity(bridge?: FloatingKinBridge) {
  const [sample, setSample] = useState<{
    activity: FloatingKinActivityState;
    at: number;
  }>(() => ({
    activity: { state: bridge ? "starting" : "unavailable" },
    at: Date.now()
  }));
  const inFlight = useRef<Promise<FloatingKinActivityState> | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let closed = false;
    let polling = false;
    let timer: number | undefined;
    const poll = async () => {
      if (closed || polling || document.hidden) return;
      polling = true;
      let activity: FloatingKinActivityState;
      const read = (inFlight.current ??= Promise.resolve().then(() =>
        bridge.activity()
      ));
      try {
        activity = await read;
      } catch {
        activity = { state: "unavailable" };
      } finally {
        if (inFlight.current === read) inFlight.current = null;
        polling = false;
      }
      if (closed || document.hidden) return;
      setSample({ activity, at: Date.now() });
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
  }, [bridge]);
  return sample;
}

type SummaryView = {
  request: FloatingKinSummaryRequest;
  result: FloatingKinSummary | null;
};

export function useSummary(bridge?: FloatingKinBridge) {
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

export function useOverlayWindow(bridge?: FloatingKinBridge) {
  const surface = useRef<HTMLElement>(null);
  const interactive = useRef(false);
  const setInteractive = (value: boolean) => {
    if (interactive.current === value) return;
    interactive.current = value;
    bridge?.setInteractive(value);
  };
  useEffect(() => {
    const node = surface.current;
    if (!bridge || !node) return;
    let size = "";
    const resize = () => {
      const rect = node.getBoundingClientRect();
      const width = Math.ceil(rect.width);
      const height = Math.ceil(rect.height);
      if (!width || !height || size === `${width}:${height}`) return;
      size = `${width}:${height}`;
      bridge.setSize({ width, height });
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    return () => {
      observer.disconnect();
      interactive.current = false;
      bridge.setInteractive(false);
    };
  }, [bridge]);
  return { surface, setInteractive };
}
