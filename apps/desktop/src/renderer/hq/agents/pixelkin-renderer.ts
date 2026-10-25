/* Pixelkin Lab character specification and face painter: MIT, pin 8007c81e9f0036a2934a598e80572da7c3f966ef. */
import "./pixelkin-core.js";
import type { Agent } from "@koed/shared/agent-contract";

type Spec = {
  top?: "none" | "antenna" | "sprout" | "ears";
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
  spec.top = ["antenna", "sprout", "ears"].includes(String(value.top))
    ? (value.top as Spec["top"])
    : "none";
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
  return paintPixelkinTop(avatar, spec);
}

/** Optional pixel accessories wrap the approved Lab character, without changing old looks. */
function paintPixelkinTop(
  pixels: Uint8ClampedArray,
  spec: Spec
): Uint8ClampedArray {
  if (!spec.top || spec.top === "none") return pixels;
  const output = new Uint8ClampedArray(pixels.length);
  const scale = 0.84;
  const width = Math.round(SIZE * scale);
  const offsetX = Math.floor((SIZE - width) / 2);
  const offsetY = SIZE - width;
  let minX = SIZE,
    maxX = 0,
    topY = SIZE;
  for (let y = 0; y < width; y++) {
    for (let x = 0; x < width; x++) {
      const from = (Math.floor(y / scale) * SIZE + Math.floor(x / scale)) * 4;
      const px = x + offsetX,
        py = y + offsetY;
      output.set(pixels.subarray(from, from + 4), (py * SIZE + px) * 4);
      if (pixels[from + 3]) {
        minX = Math.min(minX, px);
        maxX = Math.max(maxX, px);
        topY = Math.min(topY, py);
      }
    }
  }
  if (topY === SIZE) return output;
  const base = spec.palette.base.match(
    /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i
  );
  const colour = base
    ? base.slice(1).map((value) => parseInt(value, 16))
    : [157, 147, 251];
  const dark = colour.map((channel) => Math.round(channel * 0.38));
  const light = colour.map((channel) =>
    Math.round(channel + (255 - channel) * 0.5)
  );
  const paint = (x: number, y: number, rgb: number[]) => {
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
    const at = (y * SIZE + x) * 4;
    output[at] = rgb[0]!;
    output[at + 1] = rgb[1]!;
    output[at + 2] = rgb[2]!;
    output[at + 3] = 255;
  };
  const rectangle = (
    x: number,
    y: number,
    w: number,
    h: number,
    rgb: number[]
  ) => {
    for (let py = y; py < y + h; py++)
      for (let px = x; px < x + w; px++) paint(px, py, rgb);
  };
  const centre = Math.round((minX + maxX) / 2);
  if (spec.top === "antenna") {
    rectangle(centre - 1, topY - 7, 3, 9, dark);
    rectangle(centre - 2, topY - 10, 5, 5, dark);
    rectangle(centre - 1, topY - 9, 3, 3, light);
  } else if (spec.top === "sprout") {
    rectangle(centre, topY - 7, 2, 9, [42, 104, 57]);
    rectangle(centre - 5, topY - 8, 5, 3, [82, 172, 100]);
    rectangle(centre + 2, topY - 10, 5, 3, [103, 194, 109]);
    rectangle(centre - 3, topY - 5, 4, 2, [42, 104, 57]);
  } else {
    for (const centreX of [minX + 7, maxX - 7]) {
      for (let row = 0; row < 7; row++) {
        for (let dx = -row; dx <= row; dx++) {
          paint(
            centreX + dx,
            topY - 7 + row,
            Math.abs(dx) === row || row === 0 ? dark : light
          );
        }
      }
    }
  }
  return output;
}

export const pixelkinResolution = SIZE;
