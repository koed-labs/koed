// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  dismissalKey,
  useSuggestionDismissals
} from "./suggestion-dismissals.js";
import type { SuggestionRow } from "./use-folder-suggestions.js";

const row = (sessionId: string, directory = "/work/koed"): SuggestionRow => ({
  sessionId,
  title: sessionId,
  proposal: {
    action: "use",
    kind: "worktree-parent",
    tier: "medium",
    directory,
    projects: ["Koed"],
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
  it("remembers a dismissed suggestion across reloads, per owner scope", async () => {
    await mount("owner-a");
    await act(async () => hook.dismiss([row("s1")]));
    expect(hook.isDismissed(row("s1"))).toBe(true);
    expect(hook.isDismissed(row("s2"))).toBe(false);
    act(() => root.unmount());
    root = createRoot(host);
    await mount("owner-a");
    expect(hook.isDismissed(row("s1"))).toBe(true);
    await mount("owner-b");
    expect(hook.isDismissed(row("s1"))).toBe(false);
  });

  it("lets a different suggestion for the same conversation through", async () => {
    await mount("owner-a");
    await act(async () => hook.dismiss([row("s1")]));
    expect(hook.isDismissed(row("s1", "/work/other"))).toBe(false);
    expect(dismissalKey(row("s1"))).not.toBe(
      dismissalKey(row("s1", "/work/other"))
    );
  });

  it("ignores unreadable saved data", async () => {
    window.localStorage.setItem("koed:suggestion-dismissals:owner-a", "{bad");
    await mount("owner-a");
    expect(hook.isDismissed(row("s1"))).toBe(false);
  });
});
