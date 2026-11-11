import { useEffect, useRef, useState, type CSSProperties } from "react";
import { DEFAULT_AGENT_LOOK, type AgentLook } from "./agent-kin.js";
import {
  addPixelkin,
  createPixelkinActor,
  hopPixelkin,
  pixelkinEngineAvailable,
  setPixelkinExpression,
  setPixelkinKin,
  wakePixelkins,
  type PixelkinActor
} from "./stage.js";
import type { KinSpin } from "../onboarding/kin-spin.js";
import "./pixelkin.css";

export function Pixelkin({
  look = DEFAULT_AGENT_LOOK,
  size = 28,
  className = "",
  hopOnChange = false,
  expression = null,
  hopKey,
  spin = null,
  presentation = "avatar"
}: {
  presentation?: "avatar" | "stage";
  look?: AgentLook;
  size?: number;
  className?: string;
  hopOnChange?: boolean;
  // Holds one expression instead of the personality's changing moods.
  expression?: "neutral" | "surprised" | "happy" | "sad" | null;
  // Each change makes the Kin hop once.
  hopKey?: number;
  // Turned by dragging; the caller feeds it pointer events.
  spin?: KinSpin | null;
}) {
  const [engine] = useState(pixelkinEngineAvailable);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const actorRef = useRef<PixelkinActor | null>(null);
  const lookKey = JSON.stringify(look);
  const shownKey = useRef(lookKey);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!engine || !canvas) return;
    const actor = createPixelkinActor(canvas, look, size, presentation);
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
    actor.presentation = presentation;
    if (shownKey.current !== lookKey) {
      shownKey.current = lookKey;
      setPixelkinKin(actor, look);
      if (hopOnChange) hopPixelkin(actor);
    }
    wakePixelkins();
    // lookKey captures every look field.
  }, [lookKey, size, hopOnChange, presentation]);
  useEffect(() => {
    const actor = actorRef.current;
    if (actor) setPixelkinExpression(actor, expression);
  }, [expression, engine]);
  useEffect(() => {
    const actor = actorRef.current;
    if (actor) actor.spin = spin;
  }, [spin, engine]);
  const firstHop = useRef(hopKey);
  useEffect(() => {
    const actor = actorRef.current;
    if (!actor || hopKey === undefined || hopKey === firstHop.current) return;
    hopPixelkin(actor);
  }, [hopKey]);
  if (!engine)
    return (
      <span
        className={`v1-pixelkin v1-pixelkin-fallback ${className}`}
        data-kin-shape={look.body.shape}
        data-kin-colour={look.palette.base}
        data-expression={expression ?? "neutral"}
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
        <b />
      </span>
    );
  return (
    <canvas
      ref={canvasRef}
      className={`v1-pixelkin ${className}`}
      data-presentation={presentation}
      data-kin-shape={look.body.shape}
      data-kin-colour={look.palette.base}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}
