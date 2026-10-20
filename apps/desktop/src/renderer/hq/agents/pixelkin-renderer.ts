/* Pixelkin Lab character specification and face painter: MIT, pin 8007c81e9f0036a2934a598e80572da7c3f966ef. */
import "./pixelkin-core.js";
import type { Agent } from "@koed/shared/agent-contract";

type Spec = {
  body: {
    shape: "sphere" | "roundedBox" | "cuboid" | "capsule";
    width: number;
    height: number;
    depth: number;
    roundness: number;
  };
  face: {
    expression: string;
    pupilTravel: number;
    faceSlide: number;
    autoBlink: boolean;
    followPointer: boolean;
  };
  palette: { base: string; grayscale: boolean };
  render: { mode: string; bands: number; outline: number };
};
type Face = { pixels: Uint8ClampedArray; width: number; height: number };
type Core = {
  generate(seed: string): Spec;
  hashSeed(seed: string): number;
  bodyDistance(body: Spec["body"], x: number, y: number, z: number): number;
  FaceRaster: new (size: number) => {
    paletteLut: Uint8ClampedArray;
    paint(
      spec: Spec,
      options: { lookX: number; lookY: number; blink: number }
    ): Face;
  };
};
const core = (globalThis as typeof globalThis & { PixelkinCore: Core })
  .PixelkinCore;
const SIZE = 64;
const EXTENT = 1.68;
const bodyCache = new WeakMap<Spec, Uint8ClampedArray>();
const clamp = (n: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, n));
const numberIn = (n: unknown, lo: number, hi: number, fallback: number) =>
  typeof n === "number" && Number.isFinite(n) ? clamp(n, lo, hi) : fallback;

/** Agent.look is an optional, owner-bound Pixelkin Lab spec; old Agents get a stable seeded character. */
export function pixelkinSpec(agent: Pick<Agent, "id" | "look">): Spec {
  const look = agent.look;
  const nested = look.pixelkin;
  const value =
    nested && typeof nested === "object" && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : look;
  const seed =
    typeof value.seed === "string" || typeof value.seed === "number"
      ? String(value.seed)
      : agent.id;
  const spec = core.generate(seed);
  const body =
    value.body && typeof value.body === "object" && !Array.isArray(value.body)
      ? (value.body as Record<string, unknown>)
      : {};
  const face =
    value.face && typeof value.face === "object" && !Array.isArray(value.face)
      ? (value.face as Record<string, unknown>)
      : {};
  const palette =
    value.palette &&
    typeof value.palette === "object" &&
    !Array.isArray(value.palette)
      ? (value.palette as Record<string, unknown>)
      : {};
  if (
    ["sphere", "roundedBox", "cuboid", "capsule"].includes(String(body.shape))
  )
    spec.body.shape = body.shape as Spec["body"]["shape"];
  spec.body.width = numberIn(body.width, 0.6, 2.5, spec.body.width);
  spec.body.height = numberIn(body.height, 0.6, 2.5, spec.body.height);
  spec.body.depth = numberIn(body.depth, 0.6, 2.5, spec.body.depth);
  spec.body.roundness = numberIn(
    body.roundness,
    0.015,
    0.7,
    spec.body.roundness
  );
  if (
    typeof palette.base === "string" &&
    /^#[0-9a-fA-F]{6}$/.test(palette.base)
  )
    spec.palette.base = palette.base;
  if (typeof palette.grayscale === "boolean")
    spec.palette.grayscale = palette.grayscale;
  if (
    typeof face.expression === "string" &&
    [
      "neutral",
      "happy",
      "joy",
      "sad",
      "angry",
      "surprised",
      "sleepy",
      "curious",
      "wink"
    ].includes(face.expression)
  )
    spec.face.expression = face.expression;
  spec.face.pupilTravel = numberIn(
    face.pupilTravel,
    0,
    1,
    spec.face.pupilTravel
  );
  spec.face.faceSlide = numberIn(face.faceSlide, 0, 1, spec.face.faceSlide);
  if (typeof face.autoBlink === "boolean") spec.face.autoBlink = face.autoBlink;
  if (typeof face.followPointer === "boolean")
    spec.face.followPointer = face.followPointer;
  return spec;
}

/** Pixelkin Lab's SDF body, neutral light bands, palette lookup, outline and separate face raster at avatar resolution. */
export function renderPixelkin(
  spec: Spec,
  lookX = 0,
  lookY = 0,
  blink = 0
): Uint8ClampedArray {
  const painter = new core.FaceRaster(SIZE);
  const face = painter.paint(spec, { lookX, lookY, blink });
  let base = bodyCache.get(spec);
  if (!base) {
    base = new Uint8ClampedArray(SIZE * SIZE * 4);
    const mask = new Uint8Array(SIZE * SIZE);
    const lut = painter.paletteLut;
    const distance = core.bodyDistance;
    for (let y = 0; y < SIZE; y++) {
      const wy = EXTENT * (1 - ((y + 0.5) * 2) / SIZE);
      for (let x = 0; x < SIZE; x++) {
        const wx = EXTENT * (((x + 0.5) * 2) / SIZE - 1);
        let z = 2.5;
        let hit = false;
        for (let step = 0; step < 42 && z > -1.5; step++) {
          const d = distance(spec.body, wx, wy, z);
          if (d < 0.003) {
            hit = true;
            break;
          }
          z -= Math.max(0.002, d * 0.84);
        }
        if (!hit) continue;
        const e = 0.007;
        const nx =
          distance(spec.body, wx + e, wy, z) -
          distance(spec.body, wx - e, wy, z);
        const ny =
          distance(spec.body, wx, wy + e, z) -
          distance(spec.body, wx, wy - e, z);
        const nz =
          distance(spec.body, wx, wy, z + e) -
          distance(spec.body, wx, wy, z - e);
        const n = Math.hypot(nx, ny, nz) || 1;
        const diffuse = Math.max(0, (nx * -0.35 + ny * 0.55 + nz * 0.76) / n);
        const tone =
          Math.round(
            clamp(1 - Math.exp(-(0.25 + diffuse * 1.2) * 1.22), 0, 1) *
              (spec.render.bands - 1)
          ) /
          (spec.render.bands - 1);
        const colour = Math.round(tone * 255) * 3;
        const p = (y * SIZE + x) * 4;
        mask[y * SIZE + x] = 1;
        base[p] = lut[colour] ?? 0;
        base[p + 1] = lut[colour + 1] ?? 0;
        base[p + 2] = lut[colour + 2] ?? 0;
        base[p + 3] = 255;
      }
    }
    for (let y = 1; y < SIZE - 1; y++)
      for (let x = 1; x < SIZE - 1; x++) {
        const i = y * SIZE + x;
        if (!mask[i]) continue;
        if (mask[i - 1] && mask[i + 1] && mask[i - SIZE] && mask[i + SIZE])
          continue;
        const p = i * 4;
        for (let c = 0; c < 3; c++)
          base[p + c] = Math.round(
            (base[p + c] ?? 0) * (1 - spec.render.outline) +
              (lut[24 + c] ?? 0) * spec.render.outline
          );
      }
    bodyCache.set(spec, base);
  }
  const data = base.slice();
  for (let i = 0; i < SIZE * SIZE; i++) {
    const p = i * 4;
    if (!data[p + 3]) continue;
    const alpha = (face.pixels[p + 3] ?? 0) / 255;
    if (!alpha) continue;
    for (let c = 0; c < 3; c++)
      data[p + c] = Math.round(
        (face.pixels[p + c] ?? 0) * alpha + (data[p + c] ?? 0) * (1 - alpha)
      );
  }
  // The Lab's Solo canvas includes studio margins; HQ crops the finished pixels
  // uniformly so the same character remains legible at 25–32 CSS pixels.
  const crop = 44;
  const inset = (SIZE - crop) / 2;
  const avatar = new Uint8ClampedArray(data.length);
  for (let y = 0; y < SIZE; y++) {
    const sourceY = Math.floor(inset + ((y + 0.5) * crop) / SIZE);
    for (let x = 0; x < SIZE; x++) {
      const sourceX = Math.floor(inset + ((x + 0.5) * crop) / SIZE);
      const from = (sourceY * SIZE + sourceX) * 4;
      avatar.set(data.subarray(from, from + 4), (y * SIZE + x) * 4);
    }
  }
  return avatar;
}

export const pixelkinResolution = SIZE;
