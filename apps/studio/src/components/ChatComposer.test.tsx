// @vitest-environment happy-dom
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatComposer } from "./ChatComposer";
import type { NativeSkill } from "./NativeSkillPicker";

const mockSkillExpiry = vi.hoisted(() => ({ value: "", resourceSuffix: "a" }));

vi.mock("./NativeSkillPicker", () => ({
  NativeSkillPicker: ({
    scope,
    onSelect
  }: {
    scope: { projectId: string | null; hostedInstanceId?: string };
    onSelect: (skill: NativeSkill, expiresAt: string) => void;
  }) => (
    <button
      type="button"
      data-testid="native-skill-picker"
      data-project={scope.projectId ?? "standalone"}
      data-client={scope.hostedInstanceId ?? "unresolved"}
      onClick={() =>
        onSelect(
          {
            resourceId: `res_${mockSkillExpiry.resourceSuffix.repeat(64)}`,
            kind: "skill",
            name: "review",
            status: "ready",
            availability: "available",
            executionSupport: "koed_managed",
            source: "user",
            invocation: "native_skill"
          },
          mockSkillExpiry.value
        )
      }
    >
      Choose /review
    </button>
  )
}));

const clients = ["computer-a", "computer-b"].map((instanceId) => ({
  provider: "codex",
  id: "gpt-6.1-sol",
  displayName: "GPT-6.1 Sol",
  instanceId,
  supportedReasoningEfforts: ["medium"]
}));

function canContinue(instanceId: string, options = clients) {
  const html = renderToStaticMarkup(
    <ChatComposer
      placeholder="Continue"
      projectName="Personal"
      branch="main"
      value="Continue our work"
      onSend={() => undefined}
      modelOptions={options}
      restoreSelection={{
        key: "saved-chat",
        provider: "codex",
        model: "gpt-6.1-sol",
        instanceId,
        effort: "medium",
        permissionMode: "ask"
      }}
    />
  );
  const button = html.match(/<button[^>]*aria-label="Send message"[^>]*>/)?.[0];
  expect(button).toBeDefined();
  return !button!.includes('disabled=""');
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  window.history.replaceState({}, "", "/");
  vi.clearAllMocks();
  vi.useRealTimers();
  mockSkillExpiry.value = "";
  mockSkillExpiry.resourceSuffix = "a";
});

function typeIntoComposer(value: string) {
  const textarea = container!.querySelector<HTMLTextAreaElement>("textarea")!;
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value"
  )?.set;
  setValue?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("saved chat AI Client selection", () => {
  it("can continue on the original computer when another offers the same model", () => {
    expect(canContinue("computer-a")).toBe(true);
  });
  it("also resolves the original client when it is the only choice", () => {
    expect(canContinue("computer-a", [clients[0]!])).toBe(true);
  });
  it("resolves the local client identity when a hosted identity is also advertised", () => {
    expect(
      canContinue(
        "computer-a",
        clients.map((client) => ({
          ...client,
          hostedInstanceId: `hosted-${client.instanceId}`
        }))
      )
    ).toBe(true);
  });
  it("does not silently substitute another computer if the original disappears", () => {
    expect(canContinue("computer-a", [clients[1]!])).toBe(false);
  });
});

describe("scoped native Skill picker visibility", () => {
  const scope = {
    projectId: "selected-project",
    hostedInstanceId: "selected-computer-codex",
    instanceId: "codex-instance",
    provider: "codex"
  };
  const markup = (props: Partial<ComponentProps<typeof ChatComposer>>) =>
    renderToStaticMarkup(
      <ChatComposer
        placeholder="Message"
        projectName="Personal"
        branch="main"
        value="/"
        onSend={() => undefined}
        {...props}
      />
    );

  it("shows the exact scoped picker in an owner-private prelaunch prompt with controls hidden", () => {
    const html = markup({
      clientResourceScope: scope,
      allowNativeSkillSelection: true,
      showExecutionControls: false
    });
    expect(html).toContain('data-testid="native-skill-picker"');
    expect(html).toContain('data-project="selected-project"');
    expect(html).toContain('data-client="selected-computer-codex"');
  });

  it("keeps the hidden-control picker disabled unless a private launch opts in", () => {
    const html = markup({
      clientResourceScope: scope,
      showExecutionControls: false
    });
    expect(html).not.toContain('data-testid="native-skill-picker"');
  });

  it("does not expose an owner's private Skills in a human collaboration requester composer", () => {
    const html = markup({ showExecutionControls: false });
    expect(html).not.toContain('data-testid="native-skill-picker"');
  });

  it("clears an expired Skill before notifying or sending its exact resource ID", async () => {
    window.history.replaceState({}, "", "/studio");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-15T12:00:00.000Z"));
    mockSkillExpiry.value = new Date(Date.now() + 500).toISOString();
    const onSend = vi.fn();
    const onSelectedResourceIdsChange = vi.fn();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        <ChatComposer
          placeholder="Message"
          projectName="Personal"
          branch="main"
          onSend={onSend}
          sendEnabled
          modelOptions={clients}
          restoreSelection={{
            key: "saved-chat",
            provider: "codex",
            model: "gpt-6.1-sol",
            instanceId: "computer-a",
            effort: "medium",
            permissionMode: "ask"
          }}
          clientResourceScope={{
            projectId: "selected-project",
            hostedInstanceId: "computer-a",
            instanceId: "computer-a",
            provider: "codex"
          }}
          onSelectedResourceIdsChange={onSelectedResourceIdsChange}
        />
      )
    );

    await act(async () => {
      typeIntoComposer("/");
    });
    await act(async () => {
      container!
        .querySelector<HTMLButtonElement>(
          '[data-testid="native-skill-picker"]'
        )!
        .click();
    });
    expect(onSelectedResourceIdsChange).toHaveBeenLastCalledWith([
      `res_${"a".repeat(64)}`
    ]);
    mockSkillExpiry.value = new Date(Date.now() + 5_000).toISOString();
    await act(async () => {
      typeIntoComposer("/");
    });
    await act(async () => {
      container!
        .querySelector<HTMLButtonElement>(
          '[data-testid="native-skill-picker"]'
        )!
        .click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(501);
    });
    expect(onSelectedResourceIdsChange).toHaveBeenLastCalledWith([]);

    await act(async () => {
      typeIntoComposer("Continue");
    });
    await act(async () => {
      container!
        .querySelector<HTMLButtonElement>('[aria-label="Send message"]')!
        .click();
      await Promise.resolve();
    });
    const submitted = onSend.mock.calls[0]?.[1];
    expect(submitted).toBeDefined();
    expect(submitted).not.toHaveProperty("selectedResourceIds");
  });

  it("keeps one selected Skill in Claude Code scope by replacing the prior choice", async () => {
    window.history.replaceState({}, "", "/studio");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-15T12:00:00.000Z"));
    mockSkillExpiry.value = new Date(Date.now() + 60_000).toISOString();
    mockSkillExpiry.resourceSuffix = "a";
    const onSelectedResourceIdsChange = vi.fn();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        <ChatComposer
          placeholder="Message"
          projectName="Personal"
          branch="main"
          onSend={() => undefined}
          sendEnabled
          clientResourceScope={{
            projectId: "selected-project",
            hostedInstanceId: "claude-computer",
            instanceId: "claude-instance",
            provider: "claude-code"
          }}
          onSelectedResourceIdsChange={onSelectedResourceIdsChange}
        />
      )
    );

    await act(async () => {
      typeIntoComposer("/");
    });
    await act(async () => {
      container!
        .querySelector<HTMLButtonElement>(
          '[data-testid="native-skill-picker"]'
        )!
        .click();
    });
    expect(onSelectedResourceIdsChange).toHaveBeenLastCalledWith([
      `res_${"a".repeat(64)}`
    ]);

    mockSkillExpiry.resourceSuffix = "b";
    await act(async () => {
      typeIntoComposer("/");
    });
    await act(async () => {
      container!
        .querySelector<HTMLButtonElement>(
          '[data-testid="native-skill-picker"]'
        )!
        .click();
    });

    expect(onSelectedResourceIdsChange).toHaveBeenLastCalledWith([
      `res_${"b".repeat(64)}`
    ]);
    expect(container.textContent).not.toContain("/review × /review ×");
  });

  it("clears private Skill IDs when routing changes to a collaboration requester", async () => {
    window.history.replaceState({}, "", "/studio");
    mockSkillExpiry.value = new Date(Date.now() + 60_000).toISOString();
    const onSend = vi.fn();
    const onSelectedResourceIdsChange = vi.fn();
    const agents = [
      {
        id: "owner-agent",
        name: "Owner Agent",
        role: "Assistant",
        lifecycle: "active" as const
      },
      {
        id: "requester-agent",
        name: "Requester Agent",
        role: "Collaborator",
        lifecycle: "active" as const,
        teamRequestOnly: true
      }
    ];
    const props = {
      placeholder: "Message",
      projectName: "Personal",
      branch: "main",
      value: "/",
      onSend,
      sendEnabled: true,
      agents,
      modelOptions: clients,
      restoreSelection: {
        key: "saved-chat",
        provider: "codex",
        model: "gpt-6.1-sol",
        instanceId: "computer-a",
        effort: "medium",
        permissionMode: "ask" as const
      },
      clientResourceScope: {
        projectId: "selected-project",
        hostedInstanceId: "computer-a",
        instanceId: "computer-a",
        provider: "codex"
      },
      onSelectedResourceIdsChange
    };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(<ChatComposer {...props} activeAgentId="owner-agent" />)
    );
    await act(async () => {
      container!
        .querySelector<HTMLButtonElement>(
          '[data-testid="native-skill-picker"]'
        )!
        .click();
    });
    expect(onSelectedResourceIdsChange).toHaveBeenLastCalledWith([
      `res_${"a".repeat(64)}`
    ]);

    await act(async () =>
      root!.render(<ChatComposer {...props} activeAgentId="requester-agent" />)
    );
    expect(onSelectedResourceIdsChange).toHaveBeenLastCalledWith([]);
    expect(
      container.querySelector('[data-testid="native-skill-picker"]')
    ).toBeNull();
    expect(container.textContent).not.toContain("/review ×");

    await act(async () => {
      container!
        .querySelector<HTMLButtonElement>('[aria-label="Send message"]')!
        .click();
      await Promise.resolve();
    });
    const submitted = onSend.mock.calls[0]?.[1];
    expect(submitted).toBeDefined();
    expect(submitted).not.toHaveProperty("selectedResourceIds");
  });
});
