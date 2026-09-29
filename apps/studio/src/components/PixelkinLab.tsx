"use client";

import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import type { AgentAvatar } from "@/lib/collab";
import {
  PIXELKIN_EXPRESSIONS,
  PIXELKIN_PALETTES,
  PIXELKIN_SHAPES,
  createPixelkinSession,
  type PixelkinSession,
} from "@/lib/pixelkin/engine";

const SHAPE_LABEL: Record<string, string> = {
  sphere: "Sphere",
  roundedBox: "Round",
  cuboid: "Cube",
  capsule: "Capsule",
};

export type PixelkinLabHandle = {
  capture: () => AgentAvatar | null;
};

function readLabState(session: PixelkinSession) {
  const spec = session.getSpec();
  return {
    expression: spec.face.expression,
    palette: spec.palette.base.toLowerCase(),
    shape: spec.body.shape,
  };
}

export const PixelkinLab = forwardRef<
  PixelkinLabHandle,
  { initialSpec?: Record<string, unknown>; onChange?: () => void }
>(function PixelkinLab({ initialSpec, onChange }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<PixelkinSession | null>(null);
  const [expression, setExpression] = useState("happy");
  const [palette, setPalette] = useState(PIXELKIN_PALETTES[0]);
  const [shape, setShape] = useState("roundedBox");

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const session = createPixelkinSession(canvas);
    sessionRef.current = session;
    // Editing an existing agent: load its saved look instead of a fresh
    // random one, so "Save changes" without touching the avatar keeps it.
    if (initialSpec) {
      session.applySpec(initialSpec);
    }
    const next = readLabState(session);
    setExpression(next.expression);
    setPalette(next.palette);
    setShape(next.shape);
    return () => {
      session.destroy();
      sessionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useImperativeHandle(ref, () => ({
    capture: () => {
      const session = sessionRef.current;
      if (!session) return null;
      const spec = session.getSpec();
      const image = session.capturePng(128);
      if (!image.startsWith("data:image/png")) return null;
      return { seed: spec.seed, spec, image };
    },
  }));

  const applySession = (mutate: (session: PixelkinSession) => void) => {
    const session = sessionRef.current;
    if (!session) return;
    mutate(session);
    onChange?.();
    const next = readLabState(session);
    setExpression(next.expression);
    setPalette(next.palette);
    setShape(next.shape);
  };

  return (
    <div className="space-y-3">
      <span className="block text-sm text-muted">Avatar</span>
      <div className="relative aspect-square w-full overflow-hidden rounded-xl border border-border bg-background">
        <canvas
          ref={canvasRef}
          className="h-full w-full cursor-crosshair"
          style={{ imageRendering: "pixelated" }}
          aria-label="Live pixel avatar. Move to look, click to bounce."
        />
      </div>
      <div className="flex gap-1">
        <button
          type="button"
          className="rounded-md bg-surface-hover px-2.5 py-1 text-xs text-foreground-secondary hover:text-foreground"
          onClick={() => applySession((session) => session.randomize())}
        >
          Randomize
        </button>
        <button
          type="button"
          className="rounded-md bg-surface-hover px-2.5 py-1 text-xs text-foreground-secondary hover:text-foreground"
          onClick={() => applySession((session) => session.reset())}
        >
          Reset
        </button>
      </div>
      <div>
        <span className="mb-1.5 block text-[11px] text-subtle">Shape</span>
        <div className="flex flex-wrap gap-1">
          {PIXELKIN_SHAPES.map((item) => (
            <button
              key={item}
              type="button"
              className={`rounded-md px-2 py-1 text-[11px] transition-colors ${
                shape === item ? "bg-chip text-chip-foreground" : "bg-surface-hover text-muted hover:text-foreground-secondary"
              }`}
              onClick={() =>
                applySession((session) => {
                  session.setShape(item);
                })
              }
            >
              {SHAPE_LABEL[item] ?? item}
            </button>
          ))}
        </div>
      </div>
      <div>
        <span className="mb-1.5 block text-[11px] text-subtle">Palette</span>
        <div className="flex flex-wrap gap-1.5">
          {PIXELKIN_PALETTES.map((hex) => (
            <button
              key={hex}
              type="button"
              aria-label={`Palette ${hex}`}
              className={`h-5 w-5 rounded-full border ${
                palette === hex.toLowerCase() ? "border-chip" : "border-border-strong"
              }`}
              style={{ backgroundColor: hex }}
              onClick={() =>
                applySession((session) => {
                  session.setPalette(hex);
                })
              }
            />
          ))}
        </div>
      </div>
      <div>
        <span className="mb-1.5 block text-[11px] text-subtle">Expression</span>
        <div className="flex flex-wrap gap-1">
          {PIXELKIN_EXPRESSIONS.map((item) => (
            <button
              key={item}
              type="button"
              className={`rounded-md px-2 py-1 text-[11px] capitalize transition-colors ${
                expression === item ? "bg-chip text-chip-foreground" : "bg-surface-hover text-muted hover:text-foreground-secondary"
              }`}
              onClick={() =>
                applySession((session) => {
                  session.setExpression(item);
                })
              }
            >
              {item}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
});
