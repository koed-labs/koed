// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useSuggestionDismissals } from "./suggestion-dismissals.js";
import type { SuggestionRow } from "./use-folder-suggestions.js";

const row = (
  sessionId: string,
  incarnation = "incarnation"
): SuggestionRow => ({
  sessionId,
  title: sessionId,
  proposal: {
    action: "use",
    kind: "worktree-parent",
    tier: "medium",
    directory: "/work/koed",
    folder: {
      ownerUserId: "00000000-0000-4000-8000-000000000001",
      folderId: "koed",
      originatingDeploymentId: "deployment",
      originatingDeviceId: "device",
      originatingProfileId: "profile",
      directoryIncarnationId: incarnation
    },
    projects: [
      { id: "a", name: "Koed" },
      { id: "b", name: "Koed" }
    ],
    evidence: []
  }
});

let root: Root;
let host: HTMLElement;
let hook: ReturnType<typeof useSuggestionDismissals>;
function Probe({ scope }: { scope: string | null }) {
  hook = useSuggestionDismissals(scope);
  return null;
}
const mount = async (scope: string | null) =>
  act(async () => root.render(<Probe scope={scope} />));

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("useSuggestionDismissals", () => {
  it("remembers a dismissal across reloads only for the same owner and Project", async () => {
    await mount("owner-a");
    await act(async () => hook.dismiss("a", [row("s1")]));
    expect(hook.isDismissed("a", row("s1"))).toBe(true);
    expect(hook.isDismissed("a", row("s2"))).toBe(false);
    expect(hook.isDismissed("b", row("s1"))).toBe(false);
    act(() => root.unmount());
    root = createRoot(host);
    await mount("owner-a");
    expect(hook.isDismissed("a", row("s1"))).toBe(true);
    expect(hook.isDismissed("b", row("s1"))).toBe(false);
    await mount("owner-b");
    expect(hook.isDismissed("a", row("s1"))).toBe(false);
  });

  it("lets a different suggestion for the same conversation through", async () => {
    await mount("owner-a");
    await act(async () => hook.dismiss("a", [row("s1")]));
    expect(hook.isDismissed("a", row("s1", "replacement"))).toBe(false);
  });

  it("ignores unreadable saved data", async () => {
    window.localStorage.setItem("koed:suggestion-dismissals:owner-a", "{bad");
    await mount("owner-a");
    expect(hook.isDismissed("a", row("s1"))).toBe(false);
  });
});
