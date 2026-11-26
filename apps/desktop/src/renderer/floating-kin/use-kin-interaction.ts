import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
  type RefObject
} from "react";
import type { FloatingKinBridge } from "../../ipc/floating-kin-protocol.js";

const dragThreshold = 4;

type Gesture = {
  handle: Element;
  pointerId: number;
  x: number;
  y: number;
  clientX: number;
  clientY: number;
  moved: boolean;
};

function hitTarget(target: EventTarget | null, surface: HTMLElement | null) {
  const hit =
    target instanceof Element ? target.closest("[data-fk-hit]") : null;
  return surface?.contains(hit) ? hit : null;
}

export function useKinInteraction(
  bridge: FloatingKinBridge | undefined,
  surface: RefObject<HTMLElement | null>,
  setInteractive: (value: boolean) => void
) {
  const gesture = useRef<Gesture | null>(null);
  const hit = useRef<Element | null>(null);
  const suppressClick = useRef<Element | null>(null);
  const [dragging, setDragging] = useState(false);

  const updateHit = (target: EventTarget | null) => {
    hit.current = hitTarget(target, surface.current);
    setInteractive(gesture.current !== null || hit.current !== null);
  };
  const finish = (target: EventTarget | null) => {
    const pending = gesture.current;
    if (!pending) return;
    gesture.current = null;
    if (pending.moved) {
      bridge?.drag({ phase: "end" });
      setDragging(false);
    }
    updateHit(target);
  };

  // A polling update can remove a hit target (or a captured handle) without a mouseout.
  useLayoutEffect(() => {
    if (gesture.current && !surface.current?.contains(gesture.current.handle)) {
      finish(null);
    } else if (hit.current && !surface.current?.contains(hit.current)) {
      updateHit(null);
    }
  });
  useEffect(
    () => () => {
      if (gesture.current?.moved) bridge?.drag({ phase: "end" });
      gesture.current = null;
      hit.current = null;
      suppressClick.current = null;
    },
    [bridge]
  );

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !event.isPrimary || gesture.current) return;
    suppressClick.current = null;
    const {
      target,
      pointerId,
      screenX: x,
      screenY: y,
      clientX,
      clientY
    } = event;
    const handle =
      target instanceof Element ? target.closest("[data-fk-handle]") : null;
    if (!bridge || !handle) return;
    event.preventDefault();
    handle.setPointerCapture(pointerId);
    gesture.current = {
      handle,
      pointerId,
      x,
      y,
      clientX,
      clientY,
      moved: false
    };
    updateHit(handle);
  };
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const pending = gesture.current;
    if (!bridge || pending?.pointerId !== event.pointerId) return;
    const { screenX: x, screenY: y, clientX, clientY } = event;
    if (event.pointerType === "mouse" && (event.buttons & 1) === 0) {
      finish(document.elementFromPoint(clientX, clientY));
      return;
    }
    pending.clientX = clientX;
    pending.clientY = clientY;
    if (!pending.moved) {
      if (Math.hypot(x - pending.x, y - pending.y) < dragThreshold) return;
      pending.moved = true;
      suppressClick.current = pending.handle.closest("button");
      bridge.drag({ phase: "start", x: pending.x, y: pending.y });
      setDragging(true);
    }
    bridge.drag({ phase: "move", x, y });
  };
  const endPointer = (event: PointerEvent<HTMLElement>) => {
    const pending = gesture.current;
    if (pending?.pointerId !== event.pointerId) return;
    const released = event.type === "pointerup";
    const target = released
      ? document.elementFromPoint(event.clientX, event.clientY)
      : event.type === "lostpointercapture"
        ? document.elementFromPoint(pending.clientX, pending.clientY)
        : null;
    // Chromium can click the captured handle even when released off the button.
    if (released && !pending.moved) {
      const button = pending.handle.closest("button");
      if (button && !button.contains(target)) suppressClick.current = button;
    }
    finish(target);
  };
  const onClickCapture = (event: MouseEvent<HTMLElement>) => {
    if (event.detail === 0 || !(event.target instanceof Node)) return;
    if (!suppressClick.current?.contains(event.target)) return;
    suppressClick.current = null;
    event.preventDefault();
    event.stopPropagation();
  };
  const onMouseOver = (event: MouseEvent<HTMLElement>) =>
    updateHit(event.target);
  const onMouseOut = (event: MouseEvent<HTMLElement>) =>
    updateHit(event.relatedTarget);

  return {
    dragging,
    handlers: {
      onMouseOver,
      onMouseOut,
      onMouseMove: onMouseOver,
      onPointerDown,
      onPointerMove,
      onPointerUp: endPointer,
      onPointerCancel: endPointer,
      onLostPointerCapture: endPointer,
      onClickCapture
    }
  };
}
