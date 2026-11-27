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
  type PixelkinActor,
  type PixelkinCuriosity
} from "./stage.js";
import type { KinSpin } from "../onboarding/kin-spin.js";
import type { KinResolution } from "../../../ipc/presentation-preferences-protocol.js";
import "./pixelkin.css";

export function Pixelkin({
  look = DEFAULT_AGENT_LOOK,
  gradientTop,
  size = 28,
  className = "",
  hopOnChange = false,
  expression = null,
  hopKey,
  spin = null,
  presentation = "avatar",
  motion = "focused",
  resolution,
  gaze = null,
  curiosity = null,
  fit = 1
}: {
  presentation?: "avatar" | "stage";
  motion?: "focused" | "unfocused" | "still";
  resolution?: KinResolution;
  look?: AgentLook;
  // Optional second stop for a gradient-enabled look, not part of saved Kin settings.
  gradientTop?: string;
  size?: number;
  className?: string;
  hopOnChange?: boolean;
  // Holds one expression instead of the personality's changing moods.
  expression?:
    | "neutral"
    | "surprised"
    | "happy"
    | "joy"
    | "sad"
    | "sleepy"
    | null;
  // Holds the gaze on a direction (x right, y up, each -1..1) instead of
  // following the pointer.
  gaze?: readonly [number, number] | null;
  // Watches a lure (a thrown coin) and glances at the screen's interests now
  // and then, instead of only following the pointer. Keep it stable.
  curiosity?: PixelkinCuriosity | null;
  // Below 1 leaves margin in the canvas, so a Kin turning to the pointer
  // keeps its arms in frame.
  fit?: number;
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
    const remove = addPixelkin(actor, {
      animateUnfocused: motion === "unfocused",
      still: motion === "still"
    });
    return () => {
      actorRef.current = null;
      remove();
    };
    // Look and size changes update the live actor below.
  }, [engine, motion]);
  useEffect(() => {
    const actor = actorRef.current;
    if (!actor) return;
    actor.size = size;
    actor.presentation = presentation;
    actor.resolution = resolution;
    if (shownKey.current !== lookKey) {
      shownKey.current = lookKey;
      setPixelkinKin(actor, look);
      if (hopOnChange) hopPixelkin(actor);
    }
    wakePixelkins();
    // lookKey captures every look field.
  }, [lookKey, size, hopOnChange, presentation, resolution]);
  useEffect(() => {
    const actor = actorRef.current;
    if (!actor) return;
    actor.gradientTop = gradientTop;
    wakePixelkins();
  }, [gradientTop, engine, motion]);
  useEffect(() => {
    const actor = actorRef.current;
    if (actor) setPixelkinExpression(actor, expression);
  }, [expression, engine, motion]);
  useEffect(() => {
    const actor = actorRef.current;
    if (actor) actor.spin = spin;
  }, [spin, engine, motion]);
  useEffect(() => {
    const actor = actorRef.current;
    if (!actor) return;
    actor.fit = fit;
    wakePixelkins();
  }, [fit, engine, motion]);
  const [gazeX, gazeY] = gaze ?? [];
  useEffect(() => {
    const actor = actorRef.current;
    if (!actor) return;
    actor.fixedGaze =
      gazeX === undefined || gazeY === undefined ? null : [gazeX, gazeY];
    wakePixelkins();
  }, [gazeX, gazeY, engine, motion]);
  useEffect(() => {
    const actor = actorRef.current;
    if (!actor) return;
    actor.curiosity = curiosity;
    if (!curiosity) delete actor.glance;
  }, [curiosity, engine, motion]);
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
        data-kin-gradient={
          look.palette.gradient && gradientTop ? true : undefined
        }
        data-expression={expression ?? "neutral"}
        style={
          {
            width: size,
            height: size,
            "--v1-kin": look.palette.base,
            "--v1-kin-gradient-top": gradientTop
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
