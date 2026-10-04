// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalAiClientResponse } from "../../../../desktop/src/ipc/local-ai-client-protocol.js";
import type { DesktopApi } from "../../../../desktop/src/types.js";
import { StudioAiClientSettings } from "./StudioAiClientSettings";

(
  globalThis as {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const readModel = (
  enabled = true,
  checked = false,
  authenticationState: "authenticated" | "unauthenticated" = "authenticated",
  hostedInstanceId?: string
) => ({
  instances: [
    {
      instanceId: "codex.default",
      ...(hostedInstanceId ? { hostedInstanceId } : {}),
      driverId: "codex" as const,
      displayName: "Codex",
      enabled
    }
  ],
  capabilitySnapshots: checked
    ? [
        {
          instanceId: "codex.default",
          authenticationState,
          healthState: "healthy" as const,
          models: [
            {
              id: "gpt-test",
              displayName: "Test Model",
              provider: "openai",
              model: "gpt-test",
              fullId: "openai/gpt-test",
              reasoningEfforts: ["low"]
            }
          ],
          localSynthesis: {
            support: "supported" as const,
            readiness: "ready" as const
          },
          observedAt: "2026-10-03T12:00:00.000Z",
          expiresAt: "2099-10-03T12:00:00.000Z",
          stale: false
        }
      ]
    : [],
  settings: [],
  defaults: {}
});

const response = (
  enabled = true,
  checked = false,
  authenticationState: "authenticated" | "unauthenticated" = "authenticated",
  hostedInstanceId?: string
): LocalAiClientResponse =>
  ({
    operation: "list",
    readModel: readModel(
      enabled,
      checked,
      authenticationState,
      hostedInstanceId
    )
  }) as unknown as LocalAiClientResponse;

const responseWithPi = (): LocalAiClientResponse => {
  const model = readModel();
  return {
    operation: "list",
    readModel: {
      ...model,
      instances: [
        ...model.instances,
        {
          instanceId: "pi.default",
          driverId: "pi",
          displayName: "Pi",
          enabled: true
        }
      ]
    }
  } as unknown as LocalAiClientResponse;
};

const responseWithClaude = (): LocalAiClientResponse =>
  ({
    operation: "list",
    readModel: {
      instances: [
        {
          instanceId: "claude.default",
          driverId: "claude",
          displayName: "Claude Code",
          enabled: true
        }
      ],
      capabilitySnapshots: [],
      settings: [],
      defaults: {}
    }
  }) as unknown as LocalAiClientResponse;

describe("Studio AI provider settings", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  afterEach(() => {
    act(() => root?.unmount());
    delete window.koedDesktop;
  });

  async function renderSettings(
    api: NonNullable<DesktopApi["localAiClients"]>,
    invoke: (
      command: string,
      args?: Record<string, unknown>
    ) => Promise<unknown>
  ) {
    container = document.createElement("div");
    document.body.append(container);
    window.koedDesktop = {
      localAiClients: api,
      invoke
    } as unknown as DesktopApi;
    root = createRoot(container);
    await act(async () => {
      root!.render(<StudioAiClientSettings />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  const button = (name: string) =>
    [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === name
    );

  it("loads saved status without probing and checks only after an explicit click", async () => {
    const api = {
      list: vi.fn(async () => response()),
      refresh: vi.fn(async () => response()),
      set: vi.fn(),
      reset: vi.fn(),
      setEnabled: vi.fn(async () => response())
    };
    const invoke = vi.fn(async () => ({ ok: true }));
    await renderSettings(api, invoke);

    expect(api.list).toHaveBeenCalledTimes(1);
    expect(api.refresh).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Configured · status not checked");
    expect(container.textContent).not.toContain("Test Model");

    await act(async () => {
      button("Check status")?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalledWith("check_codex", undefined);
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(api.refresh).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Ready");
    expect(container.textContent).not.toContain("Test Model");
  });

  it("updates the saved row when a completed check finds sign-in is required", async () => {
    const api = {
      list: vi
        .fn()
        .mockResolvedValueOnce(response(true, true))
        .mockResolvedValueOnce(response(true, true, "unauthenticated")),
      refresh: vi.fn(async () => response()),
      set: vi.fn(),
      reset: vi.fn(),
      setEnabled: vi.fn(async () => response())
    };
    const invoke = vi.fn(async () => ({
      ok: false,
      state: "needs_attention",
      message: "Sign in through Codex to use this provider."
    }));
    await renderSettings(api, invoke);

    expect(container.textContent).toContain("Ready");
    await act(async () => {
      button("Check status")?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.list).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Sign-in required");
    expect(container.textContent).toContain(
      "Sign in through Codex to use this provider."
    );
  });

  it("passes consent on repair and keeps the repair action open when the command fails", async () => {
    const api = {
      list: vi.fn(async () => response()),
      refresh: vi.fn(async () => response()),
      set: vi.fn(),
      reset: vi.fn(),
      setEnabled: vi.fn(async () => response())
    };
    const invoke = vi.fn(async () => ({
      ok: false,
      message: "Codex CLI is unavailable."
    }));
    await renderSettings(api, invoke);

    await act(async () => {
      button("Configure")?.click();
      await Promise.resolve();
    });
    await act(async () => {
      button("Repair Koed integration")?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalledWith("repair_codex", {
      operatorConsented: true
    });
    expect(container.textContent).toContain("Codex CLI is unavailable.");
    expect(container.textContent).toContain("Repair Koed integration");
  });

  it("shows Claude setup beside its provider and repairs before checking nested diagnostics", async () => {
    const api = {
      list: vi.fn(async () => responseWithClaude()),
      refresh: vi.fn(async () => responseWithClaude()),
      set: vi.fn(),
      reset: vi.fn(),
      setEnabled: vi.fn(async () => responseWithClaude())
    };
    const invoke = vi.fn(async (command: string) =>
      command === "repair_claude"
        ? { ok: true, message: "Claude Code integration repaired." }
        : {
            ok: false,
            message: "Claude Code is not signed in.",
            action: "Run claude auth login.",
            status: {
              aiClients: {
                claude: {
                  authentication: "unauthenticated",
                  profile: { state: "needs_attention" }
                }
              }
            }
          }
    );
    await renderSettings(api, invoke);

    await act(async () => {
      button("Configure")?.click();
      await Promise.resolve();
    });
    await act(async () => {
      button("Configure")?.click();
      await Promise.resolve();
    });

    const claudeRow = container.querySelector(
      '[aria-label="Configured AI providers"] li'
    );
    expect(claudeRow?.textContent).toContain("Repair and check status");
    expect(claudeRow?.textContent).toContain(
      "Claude Desktop sign-in does not authenticate Claude Code."
    );
    expect(claudeRow?.textContent).toContain("claude auth login");
    expect(claudeRow?.querySelectorAll("h3")).toHaveLength(1);
    expect(
      [...container.querySelectorAll("h3")].filter((heading) =>
        heading.textContent?.includes("Configure")
      )
    ).toHaveLength(1);

    await act(async () => {
      button("Repair and check status")?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "repair_claude",
      "check_claude"
    ]);
    expect(invoke.mock.calls[0]).toEqual([
      "repair_claude",
      { operatorConsented: true }
    ]);
    expect(invoke.mock.calls[1]).toEqual(["check_claude"]);
    expect(container.textContent).toContain(
      "Claude Code integration repaired."
    );
    expect(container.textContent).toContain("Claude Code is not signed in.");
    expect(container.textContent).toContain("Run claude auth login.");
    expect(container.textContent).toContain(
      "Run claude auth login in Terminal where Claude Code is available to sign in."
    );
    expect(button("Repair and check status")).toBeDefined();
  });

  it("passes a trimmed optional Claude Code executable path only to repair", async () => {
    const api = {
      list: vi.fn(async () => responseWithClaude()),
      refresh: vi.fn(async () => responseWithClaude()),
      set: vi.fn(),
      reset: vi.fn(),
      setEnabled: vi.fn(async () => responseWithClaude())
    };
    const invoke = vi.fn(async () => ({ ok: true }));
    await renderSettings(api, invoke);

    await act(async () => {
      button("Configure")?.click();
      await Promise.resolve();
    });

    const executableInput = container.querySelector(
      'input[placeholder="Auto-detect Claude Code"]'
    ) as HTMLInputElement;
    expect(container.textContent).toContain(
      "Choose Claude Code, not the Claude Desktop application."
    );
    await act(async () => {
      const setInputValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set;
      setInputValue?.call(executableInput, "  /opt/claude-code/bin/claude  ");
      executableInput.dispatchEvent(new Event("input", { bubbles: true }));
      executableInput.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    expect(executableInput.value).toBe("  /opt/claude-code/bin/claude  ");

    await act(async () => {
      button("Repair and check status")?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(invoke.mock.calls[0]).toEqual([
      "repair_claude",
      {
        operatorConsented: true,
        executablePath: "/opt/claude-code/bin/claude"
      }
    ]);
    expect(invoke.mock.calls[1]).toEqual(["check_claude"]);
  });

  it("copies the Claude Code sign-in command from the visible setup card", async () => {
    const api = {
      list: vi.fn(async () => responseWithClaude()),
      refresh: vi.fn(async () => responseWithClaude()),
      set: vi.fn(),
      reset: vi.fn(),
      setEnabled: vi.fn(async () => responseWithClaude())
    };
    const writeText = vi.fn(async () => undefined);
    const invoke = vi.fn(async () => ({ ok: true }));
    await renderSettings(api, invoke);
    window.koedDesktop = {
      ...window.koedDesktop,
      clipboard: { writeText }
    } as unknown as DesktopApi;

    await act(async () => {
      button("Configure")?.click();
      await Promise.resolve();
    });
    await act(async () => {
      button("Copy command")?.click();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith("claude auth login");
    expect(container.textContent).toContain("Copied claude auth login.");
  });

  it("connects a missing provider with consent and shows its refreshed registration", async () => {
    const api = {
      list: vi
        .fn()
        .mockResolvedValueOnce(response())
        .mockResolvedValueOnce(responseWithPi()),
      refresh: vi.fn(async () => response()),
      set: vi.fn(),
      reset: vi.fn(),
      setEnabled: vi.fn(async () => response())
    };
    const invoke = vi.fn(async () => ({ ok: true }));
    await renderSettings(api, invoke);

    await act(async () => {
      button("Add AI provider")?.click();
      await Promise.resolve();
    });
    await act(async () => {
      button("Connect Pi · Pi")?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalledWith("setup_pi", {
      operatorConsented: true
    });
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Provider integration configured.");
    expect(container.textContent).toContain("Pi");
    expect(
      container.querySelectorAll('[aria-label="Configured AI providers"] li')
    ).toHaveLength(2);
  });

  it("saves disable state by provider instance and reflects the returned saved status", async () => {
    const api = {
      list: vi.fn(async () =>
        response(true, true, "authenticated", "hosted-codex-1")
      ),
      refresh: vi.fn(async () => response()),
      set: vi.fn(),
      reset: vi.fn(),
      setEnabled: vi.fn(async (_instanceId: string, enabled: boolean) =>
        response(enabled)
      )
    };
    const invoke = vi.fn(async () => ({ ok: true }));
    await renderSettings(api, invoke);

    await act(async () => {
      button("Disable")?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.setEnabled).toHaveBeenCalledWith("hosted-codex-1", false);
    expect(container.textContent).toContain("Disabled");
    expect(container.textContent).toContain(
      "Provider disabled for future use."
    );
    expect(button("Enable")).toBeDefined();
    expect(invoke).not.toHaveBeenCalled();
  });
});
