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

it("keeps the grab offset across a display seam and fits to one display on drop", () => {
  const area = { x: 0, y: 0, width: 1000, height: 800 };
  const size = { width: 110, height: 110 };
  const anchor = { x: 45, y: 400 };
  expect(floatingKinBounds(size, area, anchor, true)).toEqual({
    x: -65,
    y: 290,
    width: 110,
    height: 110
  });
  expect(floatingKinBounds(size, area, anchor)).toEqual({
    x: 0,
    y: 290,
    width: 110,
    height: 110
  });
});

it("keeps a moved lower-right anchor across resizes and fits the work area", () => {
  const area = { x: -400, y: 0, width: 400, height: 600 };
  const anchor = { x: -120, y: 420 };
  expect(floatingKinBounds({ width: 110, height: 110 }, area, anchor)).toEqual({
    x: -230,
    y: 310,
    width: 110,
    height: 110
  });
  expect(floatingKinBounds({ width: 310, height: 180 }, area, anchor)).toEqual({
    x: -400,
    y: 240,
    width: 310,
    height: 180
  });
});
