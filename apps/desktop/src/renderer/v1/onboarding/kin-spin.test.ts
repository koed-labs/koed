import { describe, expect, it } from "vitest";
import { KinSpin } from "./kin-spin.js";

describe("Kin drag spin", () => {
  it("tracks the pointer, carries momentum and settles facing forward", () => {
    const spin = new KinSpin();
    spin.begin(100, 0, 400, -0.14);
    spin.move(220, 50);
    expect(spin.angle).toBeCloseTo(-0.14 + (120 / 400) * Math.PI * 2);
    expect(spin.startled).toBe(1);
    const released = spin.angle;
    spin.end(50, false);
    spin.step(1 / 60, false);
    expect(spin.angle).toBeGreaterThan(released);
    for (let i = 0; i < 300; i++) spin.step(1 / 60, false);
    expect(spin.active).toBe(false);
    expect(spin.angle).toBeCloseTo(-0.14);
    expect(spin.startled).toBe(0);
  });

  it("can be grabbed mid-spin and reversed without jumping", () => {
    const spin = new KinSpin();
    spin.begin(0, 0, 400, -0.14);
    spin.move(200, 50);
    spin.end(50, false);
    spin.step(0.05, false);
    const visible = spin.angle;
    spin.begin(200, 100, 400, visible);
    expect(spin.angle).toBe(visible);
    spin.move(180, 120);
    expect(spin.angle).toBeLessThan(visible);
    expect(spin.velocity).toBeLessThan(0);
  });

  it("keeps clicks distinct from drags and ignores movement after release", () => {
    const spin = new KinSpin();
    spin.begin(0, 0, 400, -0.14);
    spin.move(3, 30);
    expect(spin.moved).toBe(false);
    spin.end(50, false);
    spin.move(200, 60);
    expect(spin.active).toBe(false);
    expect(spin.angle).toBe(-0.14);
  });

  it.each(["cancel", "reduced"])("stops momentum on %s", (reason) => {
    const spin = new KinSpin();
    spin.begin(0, 0, 400, -0.14);
    spin.move(100, 30);
    spin.end(30, reason === "reduced", reason === "cancel");
    expect(spin.active).toBe(false);
    expect(spin.velocity).toBe(0);
  });
});
