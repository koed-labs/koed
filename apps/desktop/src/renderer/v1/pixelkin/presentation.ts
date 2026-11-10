// Shared by onboarding and Home's large Kin. Keep the canvas detail and
// surface treatment together so the two stages retain the same finish.
export function kinStageSize(width: number, height: number) {
  const scale = Math.max(2, Math.min(window.devicePixelRatio || 1, 3));
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
