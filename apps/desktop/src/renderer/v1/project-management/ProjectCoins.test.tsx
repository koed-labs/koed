// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { CountCoin } from "./ProjectCoins.js";

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const render = (count: number, tone: "gold" | "silver") =>
  act(async () => root.render(<CountCoin count={count} tone={tone} />));
const fontSize = () =>
  Number(host.querySelector("text")!.getAttribute("font-size"));

it("labels the coin with its count and marks gold and silver apart", async () => {
  await render(4, "gold");
  const gold = host.querySelector('[role="img"]')!;
  expect(gold.getAttribute("aria-label")).toBe("4");
  expect(gold.classList.contains("v1-pm-coin-count")).toBe(true);
  expect(host.querySelector(".v1-pm-coin-sparkle")).toBeNull();
  await render(8, "silver");
  expect(host.querySelector(".v1-pm-coin-suggested")).not.toBeNull();
  expect(host.querySelector(".v1-pm-coin-sparkle")).not.toBeNull();
});

it("uses a smaller face for three-digit counts so they stay on the coin", async () => {
  await render(128, "gold");
  const three = fontSize();
  await render(7, "gold");
  expect(three).toBeLessThan(fontSize());
});
