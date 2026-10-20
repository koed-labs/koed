// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HqDueControl } from "./HqDueControl.js";

describe("HQ Due control", () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });
  it("keeps undated rows free of extra controls until the row context menu opens", async () => {
    const props = {
      title: "Undated",
      dueOn: null,
      timeZone: "UTC",
      now: new Date("2026-10-20T12:00:00Z"),
      onOpenChange: vi.fn(),
      onSelect: vi.fn()
    };
    await act(async () =>
      root.render(<HqDueControl {...props} open={false} />)
    );
    expect(host.querySelector("button")).toBeNull();
    await act(async () => root.render(<HqDueControl {...props} open />));
    expect(host.querySelector('[role="menu"]')).not.toBeNull();
    expect(host.querySelectorAll('[role="menuitem"]')).toHaveLength(4);
  });
  it("offers the five due choices, saves the selected date, and restores trigger focus on Escape", async () => {
    const save = vi.fn();
    function Fixture() {
      const [open, setOpen] = useState(false);
      return (
        <HqDueControl
          title="Book room"
          dueOn="2026-10-20"
          timeZone="UTC"
          now={new Date("2026-10-20T12:00:00Z")}
          open={open}
          onOpenChange={setOpen}
          onSelect={save}
        />
      );
    }
    await act(async () => root.render(<Fixture />));
    const trigger = host.querySelector(".hq-due__trigger") as HTMLButtonElement;
    await act(async () => trigger.click());
    expect(host.querySelectorAll('[role="menuitem"]')).toHaveLength(5);
    await act(async () =>
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      )
    );
    expect(host.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await act(async () => trigger.click());
    await act(async () =>
      Array.from(host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
        .find((button) => button.textContent === "No date")!
        .click()
    );
    expect(save).toHaveBeenCalledWith(null);
  });
});
