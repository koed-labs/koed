import { KIN_DEFAULTS } from "../pixelkin/vendor/index.js";
// The nine Kin from the homepage crowd. Keep each silhouette, material and
// face together so other scenes can use the same characters.
const specs = [
  {
    shape: "roundedBox",
    width: 1.72,
    height: 1.9,
    depth: 1.42,
    roundness: 0.3,
    palette: "#6238f2"
  },
  {
    shape: "sphere",
    width: 1.5,
    height: 1.62,
    depth: 1.42,
    roundness: 0.4,
    palette: "#b8ff00"
  },
  {
    shape: "capsule",
    width: 1.32,
    height: 1.78,
    depth: 1.24,
    roundness: 0.35,
    palette: "#20df86"
  },
  {
    shape: "roundedBox",
    width: 1.55,
    height: 1.7,
    depth: 1.34,
    roundness: 0.36,
    palette: "#ff3875"
  },
  {
    shape: "roundedBox",
    width: 1.35,
    height: 1.74,
    depth: 1.2,
    roundness: 0.04,
    palette: "#149bff"
  },
  {
    shape: "sphere",
    width: 1.52,
    height: 1.5,
    depth: 1.42,
    roundness: 0.4,
    palette: "#ffe02b"
  },
  {
    shape: "capsule",
    width: 1.28,
    height: 1.86,
    depth: 1.22,
    roundness: 0.35,
    palette: "#7858ff"
  },
  {
    shape: "roundedBox",
    width: 1.62,
    height: 1.58,
    depth: 1.4,
    roundness: 0.26,
    palette: "#0de9e2"
  },
  {
    shape: "roundedBox",
    width: 1.42,
    height: 1.72,
    depth: 1.26,
    roundness: 0.04,
    palette: "#ff6a00"
  }
] as const;

export const onboardingSkins = specs.map((spec, index) => ({
  seed: 8100 + index,
  body: {
    ...KIN_DEFAULTS.body,
    shape: spec.shape,
    width: spec.width,
    height: spec.height,
    depth: spec.depth,
    roundness: spec.roundness
  },
  palette: spec.palette,
  browThickness: index === 0 ? 1.2 : 0,
  gradient: [0, 1, 3, 7].includes(index),
  gradientReverse: index === 3,
  gradientComplement: index === 1 ? "#a58aff" : undefined,
  glitter: [0, 2, 7].includes(index) ? 0.5 : 0,
  faceStyle: [
    1 + Math.sin(index * 1.7) * 0.08,
    1 + Math.cos(index * 1.3) * 0.07,
    1 + Math.sin(index * 0.9) * 0.08,
    1 + Math.cos(index * 1.9) * 0.06
  ],
  phase: (index * 0.83) % (Math.PI * 2)
}));

function seededUnit(seed: number, step: number) {
  const value = Math.sin(seed * 12.9898 + step * 78.233) * 43758.5453;
  return value - Math.floor(value);
}

function easedProgress(progress: number) {
  const clamped = Math.max(0, Math.min(1, progress));
  return clamped * clamped * (3 - 2 * clamped);
}

export function createHappyJoyCycle(
  seed: number,
  initial: "happy" | "joy" = "happy"
) {
  const segmentCount = 8;
  const segments = Array.from({ length: segmentCount }, (_, index) => ({
    hold: 2.4 + seededUnit(seed, index * 2) * 2.8,
    transition: 0.42 + seededUnit(seed, index * 2 + 1) * 0.2
  }));
  const duration = segments.reduce(
    (total, segment) => total + segment.hold + segment.transition,
    0
  );

  return (
    time: number
  ): { from: "happy" | "joy"; to: "happy" | "joy"; progress: number } => {
    let position = ((Math.max(0, time) % duration) + duration) % duration;
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]!;
      const current =
        index % 2 === 0 ? initial : initial === "happy" ? "joy" : "happy";
      const next = current === "happy" ? "joy" : "happy";
      if (position <= segment.hold)
        return { from: current, to: current, progress: 0 };
      if (position <= segment.hold + segment.transition) {
        return {
          from: current,
          to: next,
          progress: easedProgress(
            (position - segment.hold) / segment.transition
          )
        };
      }
      position -= segment.hold + segment.transition;
    }

    return { from: initial, to: initial, progress: 0 };
  };
}
