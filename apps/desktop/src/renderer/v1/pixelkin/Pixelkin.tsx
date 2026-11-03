import { useEffect, useRef, useState, type CSSProperties } from "react";
import { DEFAULT_AGENT_LOOK, type AgentLook } from "./agent-kin.js";
import {
  addPixelkin,
  createPixelkinActor,
  hopPixelkin,
  pixelkinEngineAvailable,
  setPixelkinKin,
  wakePixelkins,
  type PixelkinActor
} from "./stage.js";
import "./pixelkin.css";

export function Pixelkin({
  look = DEFAULT_AGENT_LOOK,
  size = 28,
  className = "",
  hopOnChange = false
}: {
  look?: AgentLook;
  size?: number;
  className?: string;
  hopOnChange?: boolean;
}) {
  const [engine] = useState(pixelkinEngineAvailable);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const actorRef = useRef<PixelkinActor | null>(null);
  const lookKey = JSON.stringify(look);
  const shownKey = useRef(lookKey);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!engine || !canvas) return;
    const actor = createPixelkinActor(canvas, look, size);
    actorRef.current = actor;
    const remove = addPixelkin(actor);
    return () => {
      actorRef.current = null;
      remove();
    };
    // Look and size changes update the live actor below.
  }, [engine]);
  useEffect(() => {
    const actor = actorRef.current;
    if (!actor) return;
    actor.size = size;
    if (shownKey.current !== lookKey) {
      shownKey.current = lookKey;
      setPixelkinKin(actor, look);
      if (hopOnChange) hopPixelkin(actor);
    }
    wakePixelkins();
    // lookKey captures every look field.
  }, [lookKey, size, hopOnChange]);
  if (!engine)
    return (
      <span
        className={`v1-pixelkin v1-pixelkin-fallback ${className}`}
        data-kin-shape={look.body.shape}
        data-kin-colour={look.palette.base}
        style={
          {
            width: size,
            height: size,
            "--v1-kin": look.palette.base
          } as CSSProperties
        }
        aria-hidden="true"
      >
        <i />
        <i />
      </span>
    );
  return (
    <canvas
      ref={canvasRef}
      className={`v1-pixelkin ${className}`}
      data-kin-shape={look.body.shape}
      data-kin-colour={look.palette.base}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}
