import { describe, expect, it } from "vitest";
import {
  STAGE_LABEL_WIDTH,
  STAGE_MAX_SCALE,
  layoutStage,
  type StageSlot
} from "./stage-layout.js";

const slots: StageSlot[] = [
  { x: 0, y: 0, size: 144, label: 38 },
  { x: -250, y: 34, size: 100, label: 38 },
  { x: 250, y: 34, size: 100, label: 38 },
  { x: -150, y: 200, size: 64, label: 17 },
  { x: 410, y: 140, size: 64, label: 17 }
];

// The top of each Kin's label-to-head box, from the stage's bottom edge.
const tops = (layout: ReturnType<typeof layoutStage>) =>
  layout.placements.map(
    (placement, index) =>
      placement.bottom + placement.size * 1.12 + 6 + slots[index]!.label
  );

describe("layoutStage", () => {
  it("keeps design size until the stage has been measured", () => {
    const layout = layoutStage(null, 120, slots);
    expect(layout.scale).toBe(1);
    expect(layout.placements[0]).toEqual({ x: 0, bottom: 120, size: 144 });
  });

  it.each([
    [840, 348],
    [1080, 536],
    [1560, 786]
  ])("fits every Kin inside a %ix%i stage", (width, height) => {
    const reserve = 100;
    const layout = layoutStage({ width, height }, reserve, slots);
    for (const top of tops(layout)) expect(top).toBeLessThanOrEqual(height);
    for (const placement of layout.placements) {
      expect(placement.bottom).toBeGreaterThanOrEqual(reserve);
      expect(Math.abs(placement.x) + STAGE_LABEL_WIDTH / 2).toBeLessThanOrEqual(
        width / 2
      );
    }
  });

  it("grows the Kin on a large stage, up to a limit", () => {
    const small = layoutStage({ width: 840, height: 348 }, 100, slots);
    const large = layoutStage({ width: 3000, height: 2000 }, 100, slots);
    expect(large.placements[0]!.size).toBeGreaterThan(
      small.placements[0]!.size
    );
    expect(large.scale).toBe(STAGE_MAX_SCALE);
  });

  it("lands the spotlight on the lead Kin", () => {
    const layout = layoutStage({ width: 1080, height: 536 }, 100, [
      { x: -110, y: 0, size: 144, label: 38 },
      { x: 110, y: 16, size: 112, label: 38 }
    ]);
    const lead = layout.placements[0]!;
    expect(layout.spot.x).toBe(lead.x);
    expect(layout.spot.size).toBe(lead.size);
    expect(layout.spot.bottom).toBeGreaterThan(lead.bottom);
    expect(layout.spot.bottom).toBeLessThan(lead.bottom + 38 + lead.size / 2);
  });
});
