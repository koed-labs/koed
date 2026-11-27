import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ConversationDescription } from "@koed-labs/kin-engine";
import { pixelkinEngineAvailable } from "../pixelkin/stage.js";
import {
  currentKinResolution,
  subscribeKinResolution
} from "../../state/kin-resolution.js";
import { CoinArtwork, type CoinClient } from "./CoinArtwork.js";
import type { CoinAge } from "./coin-age.js";
import { COIN_FRAME, clientFaceMark, paintCoin } from "./coin-paint.js";
import "./coin.css";

/** What a coin shows, in the app's terms; kin-engine decides how. */
export type CoinLook = {
  client: CoinClient;
  age?: CoinAge;
  /** Conversation turns: a thin dime to a heavy doubloon. */
  turns: number;
  /** Lying on the floor (the default), or standing: held, thrown, falling. */
  pose?: "lying" | "standing";
  /** Warm light, 0 to 1: a coin on its way into a Kin. */
  glow?: number;
  /** A standing coin turned end over end, in radians: a thrown coin. */
  tumble?: number;
};

/** How far a standing coin tips back towards the viewer, in radians. */
const FACING_TILT = -0.3;

/** A tumbling coin is drawn at one of this many turns, each rendered once
 * and cached, so a spinning coin only swaps images. */
const TUMBLE_STEPS = 32;
const TUMBLE_STEP = (2 * Math.PI) / TUMBLE_STEPS;

/** The turn to draw for `tumble`, snapped to a cached step. */
const tumbleStep = (tumble: number) => {
  const step = Math.round(tumble / TUMBLE_STEP) % TUMBLE_STEPS;
  return (step < 0 ? step + TUMBLE_STEPS : step) * TUMBLE_STEP;
};

/** The vector coin's width: kin-engine's floor sizes, 14 to 28 pixels. */
const fallbackCoinSize = (turns: number) =>
  Math.round(
    14 + 14 * Math.max(0, Math.min(1, Math.log2(Math.max(turns, 1)) / 7))
  );

/**
 * A Conversation's coin. kin-engine draws it with the Kin's renderer; without
 * WebGL2 it falls back to the vector coin, `vectorSize` pixels wide.
 */
export function CoinFace({
  look,
  vectorSize,
  hover
}: {
  look: CoinLook;
  vectorSize?: number;
  /** Shown only while its `.v1-coin-host` is hovered or focused ("show"),
   * or hidden then ("hide"). */
  hover?: "show" | "hide";
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [vector, setVector] = useState(() => !pixelkinEngineAvailable());
  const { client, age, turns, glow } = look;
  const pose = look.pose ?? "lying";
  const turn = pose === "standing" ? tumbleStep(look.tumble ?? 0) : 0;
  // Repaint at the new density when the Kin's resolution setting changes.
  const resolution = useSyncExternalStore(
    subscribeKinResolution,
    currentKinResolution
  );
  useLayoutEffect(() => {
    const target = canvas.current;
    if (vector || !target) return;
    const mark = client && clientFaceMark(client);
    // Home's floor has no viewed Project, so membership is left out.
    const description: ConversationDescription = {
      age: age ?? "current",
      weight: turns,
      pose:
        pose === "standing"
          ? // Tipped back a little, so the face looks up at the viewer and
            // the edge shows below it, as a lying coin's does. A thrown coin
            // turns end over end from there, drawn by the engine with its
            // edge and light where they belong at every turn.
            { kind: "tumbling", angle: FACING_TILT + turn }
          : { kind: "lying" },
      ...(glow && { glow }),
      ...(mark && { faceMark: mark })
    };
    if (!paintCoin(target, description)) setVector(true);
  }, [vector, client, age, turns, pose, glow, turn, resolution]);

  if (!vector)
    return (
      <canvas
        ref={canvas}
        className="v1-coin-canvas"
        data-pose={pose}
        data-hover={hover}
        width={COIN_FRAME}
        height={COIN_FRAME}
        aria-hidden="true"
      />
    );
  const size = vectorSize ?? fallbackCoinSize(turns);
  return (
    <span
      className="v1-coin-vector"
      data-pose={pose}
      data-hover={hover}
      data-age={age}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <CoinArtwork client={client} />
    </span>
  );
}

/**
 * A coin lying on a stage floor that stands up to face the viewer while its
 * host (a `.v1-coin-host` button) is hovered or focused, as Home's coins
 * always have. Both poses are rendered once and cached, so hovering only
 * swaps images.
 */
export function RestingCoin({
  look,
  vectorSize
}: {
  look: CoinLook;
  vectorSize?: number;
}) {
  return (
    <>
      <CoinFace
        look={{ ...look, pose: "lying" }}
        hover="hide"
        {...(vectorSize !== undefined && { vectorSize })}
      />
      <CoinFace
        look={{ ...look, pose: "standing" }}
        hover="show"
        {...(vectorSize !== undefined && { vectorSize })}
      />
    </>
  );
}
