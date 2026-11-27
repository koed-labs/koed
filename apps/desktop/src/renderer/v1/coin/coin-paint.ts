import {
  coins,
  kinScene,
  type ConversationCoverageMask,
  type ConversationDescription
} from "@koed-labs/kin-engine";
import type { SupportedAiClientDriverId } from "@koed-labs/shared/ai-client-contract";
import { AI_CLIENT_LOGO_PATHS } from "../../views/personal/AiClientLogo.js";
import { sharedKinRenderer } from "../pixelkin/stage.js";
import { currentKinResolution } from "../../state/kin-resolution.js";

/**
 * Conversation coins drawn by kin-engine with the Kin's own renderer, so
 * coins and Kin share one look and one WebGL2 context. Like each Pixelkin,
 * a coin is rendered on the shared canvas and copied into its own canvas.
 * Coins that look alike share one rendering.
 *
 * Coins follow the Kin's resolution setting: "classic" keeps one engine
 * pixel per CSS pixel, crisp pixel art; otherwise they render at the
 * display's density, as stage Kin do, and the browser filters them down.
 */

/** The engine's reference frame: at this size a coin is 14 to 28 pixels
 * wide, its floor size. */
const SCENE = 96;
/** The part of the frame a coin's canvas keeps, around the coin. */
export const COIN_FRAME = 36;
/** Looking down at a lying coin, about as steeply as Home's flattened coins. */
const FLOOR_CAMERA_HEIGHT = 7;
/** A coin held up to face the viewer is seen level, so its edge shows below
 * the face, lit from above, as on the floor. Seen from the floor camera an
 * upright coin shows its edge above the face instead, shaded upside down. */
const FACING_CAMERA_HEIGHT = 0;

const cache = new Map<string, HTMLCanvasElement>();
const marks = new Map<SupportedAiClientDriverId, ConversationCoverageMask>();
/** Each mark's client, so cache keys name the mark instead of its samples. */
const markIds = new WeakMap<object, string>();

/** Engine pixels per CSS pixel: stage Kin's display scale (2 to 3), or 1
 * for the classic pixel-art look. */
export function coinPixelRatio() {
  if (currentKinResolution() === "classic") return 1;
  return Math.max(2, Math.min(window.devicePixelRatio || 1, 3));
}

/** The side of a face mark's coverage mask: fine enough for the AI Client
 * logos' thin strokes at three times density. */
const MARK_SIZE = 32;

/** An AI Client's logo as a filtered coverage mask for the coin face. The
 * same mask object is reused, so kin-engine uploads it once. */
export function clientFaceMark(id: SupportedAiClientDriverId) {
  const known = marks.get(id);
  if (known) return known;
  const canvas = document.createElement("canvas");
  canvas.width = MARK_SIZE;
  canvas.height = MARK_SIZE;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return undefined;
  context.scale(MARK_SIZE / 24, MARK_SIZE / 24);
  for (const path of AI_CLIENT_LOGO_PATHS[id])
    context.fill(new Path2D(path.d), path.fillRule ?? "nonzero");
  const { data } = context.getImageData(0, 0, MARK_SIZE, MARK_SIZE);
  // The alpha channel as it is: partial coverage keeps strokes smooth.
  const coverage = new Uint8Array(MARK_SIZE * MARK_SIZE);
  for (let i = 0; i < coverage.length; i++) coverage[i] = data[i * 4 + 3]!;
  const mask = Object.freeze({
    width: MARK_SIZE,
    height: MARK_SIZE,
    coverage
  });
  marks.set(id, mask);
  markIds.set(mask, `client:${id}`);
  return mask;
}

const cacheKey = (description: ConversationDescription, ratio: number) =>
  `${ratio}:${JSON.stringify(description, (key, value: unknown) =>
    key === "faceMark" && value && typeof value === "object"
      ? (markIds.get(value) ?? value)
      : value
  )}`;

function render(description: ConversationDescription, ratio: number) {
  const gl = sharedKinRenderer();
  if (!gl) return null;
  const base = kinScene({
    width: SCENE,
    height: SCENE,
    pixelRatio: ratio,
    objects: [],
    conversationLayer: {
      set: coins,
      reducedMotion: true,
      objects: [{ x: 0, y: 0, z: 0, description }]
    }
  });
  const scene = {
    ...base,
    camera: {
      ...base.camera,
      position: {
        ...base.camera.position,
        y:
          description.pose?.kind === "lying"
            ? FLOOR_CAMERA_HEIGHT
            : FACING_CAMERA_HEIGHT
      }
    }
  };
  if (!gl.render(scene)) return null;
  // The engine may scale an oversized request down; read what it drew.
  const scale = Math.min(gl.canvas.width, gl.canvas.height) / SCENE;
  const size = Math.round(COIN_FRAME * ratio);
  const out = document.createElement("canvas");
  out.width = size;
  out.height = size;
  const context = out.getContext("2d");
  if (!context) return null;
  const from = ((SCENE - COIN_FRAME) / 2) * scale;
  context.drawImage(
    gl.canvas,
    from,
    from,
    COIN_FRAME * scale,
    COIN_FRAME * scale,
    0,
    0,
    size,
    size
  );
  return out;
}

/** Paints a coin into `canvas`, a COIN_FRAME-pixel square in CSS. Returns
 * false when kin-engine can't draw, so the caller shows the vector coin. */
export function paintCoin(
  canvas: HTMLCanvasElement,
  description: ConversationDescription
) {
  const ratio = coinPixelRatio();
  const key = cacheKey(description, ratio);
  let art = cache.get(key);
  if (!art) {
    const rendered = render(description, ratio);
    if (!rendered) return false;
    art = rendered;
    cache.set(key, art);
  }
  if (canvas.width !== art.width) {
    canvas.width = art.width;
    canvas.height = art.height;
  }
  const context = canvas.getContext("2d");
  if (!context) return false;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(art, 0, 0);
  // Classic stays crisp; denser renders let the browser filter them down.
  if (ratio === 1) canvas.dataset.pixelated = "";
  else delete canvas.dataset.pixelated;
  return true;
}
