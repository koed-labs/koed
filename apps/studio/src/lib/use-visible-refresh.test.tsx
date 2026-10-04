// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useVisibleRefresh } from "./use-visible-refresh";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
let hidden = false;
let online = true;
function Harness({ refresh }: { refresh: () => Promise<boolean | void> }) {
  useVisibleRefresh(refresh);
  return null;
}
async function mount(refresh: () => Promise<boolean | void>) {
  await act(async () => root.render(<Harness refresh={refresh} />));
  await tick(0);
}
async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  online = true;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it("refreshes on entry and every 30 seconds after completion", async () => {
  const refresh = vi.fn().mockResolvedValue(true);
  await mount(refresh);
  expect(refresh).toHaveBeenCalledTimes(1);
  await tick(29_999);
  expect(refresh).toHaveBeenCalledTimes(1);
  await tick(1);
  expect(refresh).toHaveBeenCalledTimes(2);
});
it("pauses hidden and offline work, then refreshes when returning", async () => {
  const refresh = vi.fn().mockResolvedValue(true);
  await mount(refresh);
  hidden = true;
  document.dispatchEvent(new Event("visibilitychange"));
  await tick(120_000);
  expect(refresh).toHaveBeenCalledTimes(1);
  hidden = false;
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(refresh).toHaveBeenCalledTimes(2);
  online = false;
  window.dispatchEvent(new Event("offline"));
  await tick(120_000);
  expect(refresh).toHaveBeenCalledTimes(2);
  online = true;
  await act(async () => window.dispatchEvent(new Event("online")));
  expect(refresh).toHaveBeenCalledTimes(3);
});
it("does not overlap requests and stops on unmount", async () => {
  let complete!: (value: boolean) => void;
  const refresh = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        complete = resolve;
      })
  );
  await mount(refresh);
  window.dispatchEvent(new Event("focus"));
  window.dispatchEvent(new Event("online"));
  await tick(120_000);
  expect(refresh).toHaveBeenCalledTimes(1);
  await act(async () => complete(true));
  await tick(29_999);
  expect(refresh).toHaveBeenCalledTimes(1);
  await tick(1);
  expect(refresh).toHaveBeenCalledTimes(2);
  await act(async () => root.unmount());
  await act(async () => complete(true));
  await tick(120_000);
  expect(refresh).toHaveBeenCalledTimes(2);
});
it("backs off after failures and returns to 30 seconds after recovery", async () => {
  const refresh = vi
    .fn()
    .mockResolvedValueOnce(false)
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(true);
  await mount(refresh);
  await tick(59_999);
  expect(refresh).toHaveBeenCalledTimes(1);
  await tick(1);
  expect(refresh).toHaveBeenCalledTimes(2);
  await tick(120_000);
  expect(refresh).toHaveBeenCalledTimes(3);
  await tick(30_000);
  expect(refresh).toHaveBeenCalledTimes(4);
});
