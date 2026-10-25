// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopStatusStore } from "../../services/desktop-commands.js";
import { initialHqOnboarding } from "../onboarding/onboarding-preference.js";
import { HqSetup } from "./HqSetup.js";

const renderOnboarding = vi.hoisted(() => vi.fn());
vi.mock("../HqShell.js", () => ({
  HqShell: ({ children }: { children: ReactNode }) => <main>{children}</main>
}));
vi.mock("../onboarding/HqOnboarding.js", () => ({
  HqOnboarding: (props: unknown) => {
    renderOnboarding(props);
    return <section>Your agent</section>;
  }
}));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => vi.clearAllMocks());

describe("HQ first-run entry", () => {
  const render = async (refresh: () => unknown, complete: () => unknown) => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <HqSetup
          onComplete={async () => {
            await complete();
          }}
          statusStore={{ refresh } as unknown as DesktopStatusStore}
        />
      )
    );
    return {
      host,
      cleanup: async () => {
        await act(async () => root.unmount());
        host.remove();
      }
    };
  };

  it("opens the conversational agent step without starting local setup", async () => {
    const refresh = vi.fn();
    const complete = vi.fn();
    const { host, cleanup } = await render(refresh, complete);
    try {
      expect(host.textContent).toContain("Your agent");
      expect(host.textContent).not.toContain("Set up Koed");
      expect(refresh).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
      expect(renderOnboarding.mock.calls[0]![0]).not.toHaveProperty("ownerId");
    } finally {
      await cleanup();
    }
  });

  it("completes the first-run entry before the background status refresh", async () => {
    const order: string[] = [];
    const refresh = vi.fn(() => {
      order.push("readiness");
      return new Promise(() => undefined);
    });
    const complete = vi.fn(async () => {
      order.push("complete");
    });
    const { cleanup } = await render(refresh, complete);
    try {
      const props = renderOnboarding.mock.calls[0]![0] as {
        onComplete: (record: typeof initialHqOnboarding) => Promise<void>;
      };
      await props.onComplete({ ...initialHqOnboarding, completed: true });
      expect(order).toEqual(["complete", "readiness"]);
    } finally {
      await cleanup();
    }
  });
});
