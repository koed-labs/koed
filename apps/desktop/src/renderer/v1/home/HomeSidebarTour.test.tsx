// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  HomeSidebarTour,
  type HomeSidebarTourStep
} from "./HomeSidebarTour.js";

let root: Root;
let host: HTMLDivElement;
let anchor: HTMLButtonElement;

beforeEach(() => {
  host = document.createElement("div");
  anchor = document.createElement("button");
  document.body.append(anchor, host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  anchor.remove();
});

async function renderTour(
  onDismiss: () => Promise<void>,
  populated: boolean,
  inline = true
) {
  function Harness() {
    const [open, setOpen] = useState(true);
    const [step, setStep] = useState<HomeSidebarTourStep>(1);
    return (
      open && (
        <HomeSidebarTour
          tour={{
            step,
            onStep: setStep,
            onDismiss: async () => {
              await onDismiss();
              setOpen(false);
            }
          }}
          anchor={anchor}
          focusFallback={anchor}
          sidebarVisible={populated}
          sidebarWidth={280}
          inline={inline}
          hasConversations={populated}
          hasProject={populated}
          canCreate={populated}
        />
      )
    );
  }
  await act(async () => root.render(<Harness />));
}

const button = (name: string) =>
  [...host.querySelectorAll("button")].find(
    (control) => control.textContent === name
  )!;
const click = (name: string) => act(async () => button(name).click());

it("steps through the tour, moves keyboard focus and supports Escape", async () => {
  const dismiss = vi.fn(async () => {});
  await renderTour(dismiss, true);
  expect(host.textContent).toContain("Codex, Claude Code, and Pi");
  expect(host.textContent).toContain("No anchor");
  await click("Next");
  expect(document.activeElement).toBe(host.querySelector("h2"));
  expect(host.textContent).toContain("Select + next to Projects");
  await click("Back");
  expect(host.textContent).toContain("Step 1 of 3");
  await click("Next");
  await click("Next");
  expect(host.textContent).toContain("stays under its original Anchor");
  expect(host.textContent).toContain("Project memberships");
  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
    );
  });
  expect(dismiss).toHaveBeenCalledOnce();
  expect(host.querySelector("[data-home-tour]")).toBeNull();
  expect(document.activeElement).toBe(anchor);
});

it("explains empty and closed states and lets the user retry a failed dismissal", async () => {
  const dismiss = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(new Error("profile write failed"))
    .mockResolvedValueOnce(undefined);
  await renderTour(dismiss, false);
  expect(host.textContent).toContain("Open navigation");
  expect(host.textContent).toContain(
    "after you import or capture conversations"
  );
  await click("Next");
  expect(host.textContent).toContain("when Koed’s services are ready");
  await click("Next");
  expect(host.textContent).toContain("a captured conversation and a Project");
  await click("Skip tour");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "Couldn’t save your choice"
  );
  await click("Done");
  expect(dismiss).toHaveBeenCalledTimes(2);
  expect(host.querySelector("[data-home-tour]")).toBeNull();
});

it("allows Escape outside the callout to reach the sidebar drag handler", async () => {
  const dismiss = vi.fn(async () => {});
  await renderTour(dismiss, true, false);
  expect(document.querySelector("[data-home-tour]")).not.toBeNull();
  const onEscape = vi.fn();
  window.addEventListener("keydown", onEscape, { once: true });
  try {
    await act(async () => {
      anchor.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
    });
    expect(onEscape).toHaveBeenCalledOnce();
    expect(dismiss).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener("keydown", onEscape);
  }
});
