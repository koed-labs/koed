// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HqWorkingLine } from "./HqWorkingLine.js";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("HqWorkingLine", () => {
  it("moves through progress steps, and a reported step takes over", () => {
    vi.useFakeTimers();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(<HqWorkingLine name="Juno" activity={null} />));
    expect(host.textContent).toBe("Juno is reading your message…");
    act(() => vi.advanceTimersByTime(3_000));
    expect(host.textContent).toBe("Thinking it through…");
    act(() => vi.advanceTimersByTime(30_000));
    expect(host.textContent).toContain("Still working on it");
    act(() =>
      root.render(<HqWorkingLine name="Juno" activity="Checking memory" />)
    );
    expect(host.textContent).toBe("Checking memory…");
    act(() => root.unmount());
  });
});
