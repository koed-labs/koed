import type { KinResolution } from "../../../ipc/presentation-preferences-protocol.js";

const resolutionLimits: Record<KinResolution, number> = {
  classic: 96,
  balanced: 160,
  max: Infinity
};

// Keep the stage aspect ratio when a lower preset caps the render size.
export function kinStageSize(
  width: number,
  height: number,
  resolution: KinResolution = "max"
) {
  const displayScale = Math.max(2, Math.min(window.devicePixelRatio || 1, 3));
  const scale = Math.min(
    displayScale,
    resolutionLimits[resolution] / Math.max(width, height, 1)
  );
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}

// Home centers its Kin at zero; onboarding places them above the floor.
export function kinStageSurface(offsetY = 0) {
  return {
    lights: [
      {
        name: "Stage",
        enabled: true,
        x: 0,
        y: 10.56 + offsetY,
        z: 6.19,
        target: { x: 0, y: 1 + offsetY, z: 0 },
        distanceDecay: 0.0225,
        intensity: 3.822,
        color: "#fff0c8",
        coneRadius: 10.66,
        spotlight: true,
        volumetric: false
      }
    ],
    ambient: 0.1,
    floor: false,
    floorGlow: 0,
    coloured: true,
    bands: 4,
    pixelDensity: 18,
    dither: true,
    mode: "pixel",
    outline: 0.26,
    disco: false
  };
}
