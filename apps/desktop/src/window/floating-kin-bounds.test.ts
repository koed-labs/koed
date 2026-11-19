import { expect, it } from "vitest";
import { floatingKinBounds } from "./floating-kin-bounds.js";

it("bounds renderer dimensions inside even a small display with negative coordinates", () => {
  expect(
    floatingKinBounds(
      { width: 10_000, height: 10_000 },
      { x: -500, y: -400, width: 390, height: 235 }
    )
  ).toEqual({ x: -528 + 56, y: -372, width: 334, height: 179 });
});

it("keeps the lower-right anchor stable across resizes", () => {
  const area = { x: 10, y: 50, width: 1440, height: 900 };
  expect(floatingKinBounds({ width: 440, height: 800 }, area)).toEqual({
    x: 982,
    y: 122,
    width: 440,
    height: 800
  });
  expect(floatingKinBounds({ width: 120, height: 128 }, area)).toEqual({
    x: 1302,
    y: 794,
    width: 120,
    height: 128
  });
});
