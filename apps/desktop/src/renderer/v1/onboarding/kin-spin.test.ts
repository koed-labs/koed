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

  it("coasts through several turns after a fast flick, slowing smoothly", () => {
    const spin = new KinSpin();
    spin.begin(0, 0, 160, -0.14);
    for (let i = 1; i <= 6; i++) spin.move(i * 15, i * 16);
    const released = spin.angle;
    const thrown = spin.velocity;
    spin.end(96, false);
    spin.step(1 / 60, false);
    // The hand-off keeps the release velocity rather than snapping.
    expect(spin.velocity).toBeGreaterThan(thrown * 0.9);
    let previous = spin.velocity;
    let frames = 1;
    while (spin.velocity > 0 && frames < 600) {
      spin.step(1 / 60, false);
      expect(spin.velocity).toBeLessThanOrEqual(previous);
      previous = spin.velocity;
      frames++;
      if (spin.velocity > 0) expect(spin.angle - released).toBeGreaterThan(0);
    }
    expect(frames / 60).toBeGreaterThan(1.5);
    for (let i = 0; i < 60; i++) spin.step(1 / 60, false);
    expect(spin.active).toBe(false);
    expect(spin.angle).toBeCloseTo(-0.14);
  });

  it.each([1, -1])(
    "settles a slow release in direction %i promptly",
    (direction) => {
      const spin = new KinSpin();
      spin.begin(0, 0, 400, -0.14);
      for (let i = 1; i <= 20; i++) spin.move(direction * i * 12, i * 50);
      spin.move(direction * 241, 1080);
      spin.end(1080, false);
      for (let i = 0; i < 180 && spin.active; i++) spin.step(1 / 60, false);
      expect(spin.active).toBe(false);
      expect(spin.angle).toBeCloseTo(-0.14);
    }
  );

  it("keeps a flick's momentum when the last event before release is slow", () => {
    const spin = new KinSpin();
    spin.begin(0, 0, 160, -0.14);
    for (let i = 1; i <= 4; i++) spin.move(i * 20, i * 16);
    spin.move(81, 72);
    expect(spin.velocity).toBeGreaterThan(20);
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

  it("recovers from a missed release after two seconds without movement", () => {
    const spin = new KinSpin();
    spin.begin(0, 0, 400, -0.14);
    spin.move(150, 100);
    for (let i = 0; i < 119; i++) spin.step(1 / 60, false);
    expect(spin.dragging).toBe(true);
    for (let i = 0; i < 240; i++) spin.step(1 / 60, false);
    expect(spin.dragging).toBe(false);
    expect(spin.active).toBe(false);
    expect(spin.angle).toBeCloseTo(-0.14);
  });

  it("times out a stationary press", () => {
    const spin = new KinSpin();
    spin.begin(0, 0, 400, -0.14);
    spin.step(2, false);
    expect(spin.dragging).toBe(false);
    expect(spin.active).toBe(false);
  });

  it("uses elapsed pointer inactivity rather than time before the press", () => {
    const spin = new KinSpin();
    spin.begin(0, 1000, 400, -0.14);
    spin.step(5, false, 1500);
    expect(spin.dragging).toBe(true);
    spin.move(3, 2000);
    spin.step(0.05, false, 3999);
    expect(spin.dragging).toBe(true);
    spin.step(0.05, false, 4000);
    expect(spin.dragging).toBe(false);
  });

  it("does not shake after backtracking to the front", () => {
    const spin = new KinSpin();
    spin.begin(0, 0, 400, -0.14);
    spin.move(150, 500);
    spin.move(0, 1000);
    spin.end(1200, false);
    for (let i = 0; i < 300 && spin.active; i++) {
      spin.step(1 / 60, false);
      if (spin.angle === -0.14) expect(spin.active).toBe(false);
    }
    expect(spin.active).toBe(false);
  });

  it("does not shake when released one full turn from the front", () => {
    const spin = new KinSpin();
    spin.begin(0, 0, 400, -0.14);
    spin.move(400, 1000);
    spin.end(1200, false);
    for (let i = 0; i < 300 && spin.active; i++) {
      spin.step(1 / 60, false);
      if (spin.angle === -0.14) expect(spin.active).toBe(false);
    }
    expect(spin.active).toBe(false);
  });

  it("shakes after returning from more than a quarter turn", () => {
    const spin = new KinSpin();
    spin.begin(0, 0, 400, -0.14);
    spin.move(150, 500);
    spin.end(500, false);
    let returned = false;
    let shook = false;
    for (let i = 0; i < 300 && spin.active; i++) {
      spin.step(1 / 60, false);
      if (Math.abs(spin.angle + 0.14) < 0.002) returned = true;
      else if (returned && Math.abs(spin.angle + 0.14) > 0.01) shook = true;
    }
    expect(returned).toBe(true);
    expect(shook).toBe(true);
    expect(spin.angle).toBeCloseTo(-0.14);
  });

  it("does not shake after a quarter turn or less", () => {
    const spin = new KinSpin();
    spin.begin(0, 0, 400, -0.14);
    spin.move(100, 500);
    spin.end(1000, false);
    for (let i = 0; i < 300 && spin.active; i++) {
      spin.step(1 / 60, false);
      if (spin.angle === -0.14) expect(spin.active).toBe(false);
    }
    expect(spin.active).toBe(false);
    expect(spin.angle).toBe(-0.14);
  });

  it("recovers a missed release without animation under reduced motion", () => {
    const spin = new KinSpin();
    spin.begin(0, 0, 400, -0.14);
    spin.move(150, 100);
    for (let i = 0; i < 130; i++) spin.step(1 / 60, true);
    expect(spin.dragging).toBe(false);
    expect(spin.active).toBe(false);
    expect(spin.angle).toBe(-0.14);
    expect(spin.startled).toBe(0);
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
