import { useEffect, useMemo, useRef } from "react";
import type { Agent } from "@koed/shared/agent-contract";
import {
  pixelkinResolution,
  pixelkinSpec,
  renderPixelkin
} from "./pixelkin-renderer.js";
import "./pixelkin.css";

export function Pixelkin({
  agent,
  size = 32,
  className = ""
}: {
  agent: Pick<Agent, "id" | "name" | "look">;
  size?: number;
  className?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const spec = useMemo(() => pixelkinSpec(agent), [agent.id, agent.look]);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const context = element.getContext("2d", { alpha: true });
    if (!context) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let onScreen = typeof IntersectionObserver === "undefined";
    let visible = document.visibilityState !== "hidden";
    let gazeX = 0,
      gazeY = 0,
      blink = 0,
      scheduled = 0,
      blinkTimer = 0,
      reopenTimer = 0;
    let blinkCount = 0;
    const draw = () => {
      scheduled = 0;
      if (!visible || !onScreen) return;
      const image = context.createImageData(
        pixelkinResolution,
        pixelkinResolution
      );
      image.data.set(renderPixelkin(spec, gazeX, gazeY, blink));
      context.putImageData(image, 0, 0);
    };
    const requestDraw = () => {
      if (!scheduled) scheduled = window.requestAnimationFrame(draw);
    };
    const blinkLater = () => {
      window.clearTimeout(blinkTimer);
      if (!visible || !onScreen || motion.matches || !spec.face.autoBlink)
        return;
      // A distinct deterministic cadence per Agent, without a global animation loop.
      const delay =
        2700 +
        (((agent.id.charCodeAt(blinkCount++ % agent.id.length) || 0) * 37 +
          blinkCount * 503) %
          2900);
      blinkTimer = window.setTimeout(() => {
        blink = 1;
        requestDraw();
        reopenTimer = window.setTimeout(() => {
          blink = 0;
          requestDraw();
          blinkLater();
        }, 125);
      }, delay);
    };
    const sync = () => {
      visible = document.visibilityState !== "hidden";
      if (!visible || !onScreen || motion.matches) {
        window.clearTimeout(blinkTimer);
        window.clearTimeout(reopenTimer);
        if (scheduled) window.cancelAnimationFrame(scheduled);
        scheduled = 0;
        gazeX = 0;
        gazeY = 0;
        blink = 0;
        if (visible && onScreen) requestDraw();
      } else {
        requestDraw();
        blinkLater();
      }
    };
    const pointer = (event: PointerEvent) => {
      if (!visible || !onScreen || motion.matches || !spec.face.followPointer)
        return;
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2,
        y = rect.top + rect.height / 2;
      gazeX = Math.max(
        -1,
        Math.min(1, (event.clientX - x) / Math.max(64, window.innerWidth / 3))
      );
      gazeY = Math.max(
        -1,
        Math.min(1, (y - event.clientY) / Math.max(64, window.innerHeight / 3))
      );
      requestDraw();
    };
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver((entries) => {
            onScreen = entries[0]?.isIntersecting === true;
            sync();
          });
    observer?.observe(element);
    document.addEventListener("visibilitychange", sync);
    motion.addEventListener("change", sync);
    window.addEventListener("pointermove", pointer, { passive: true });
    requestDraw();
    if (onScreen) blinkLater();
    return () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", sync);
      motion.removeEventListener("change", sync);
      window.removeEventListener("pointermove", pointer);
      window.clearTimeout(blinkTimer);
      window.clearTimeout(reopenTimer);
      if (scheduled) window.cancelAnimationFrame(scheduled);
    };
  }, [agent.id, spec]);
  return (
    <canvas
      ref={canvas}
      className={`hq-pixelkin ${className}`.trim()}
      width={pixelkinResolution}
      height={pixelkinResolution}
      style={{ width: size, height: size }}
      role="img"
      aria-label={`${agent.name} Pixelkin`}
    />
  );
}
