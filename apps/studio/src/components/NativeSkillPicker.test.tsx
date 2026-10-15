// @vitest-environment happy-dom
import { act } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { NativeSkillPicker, type NativeSkillScope } from "./NativeSkillPicker";
import {
  discoverClientResources,
  loadClientResourceTargets,
  type ClientResourceTarget
} from "@/lib/client-resources-client";

vi.mock("@/lib/client-resources-client", async (original) => ({
  ...(await original<object>()),
  loadClientResourceTargets: vi.fn(),
  discoverClientResources: vi.fn()
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement;
const onSelect = vi.fn();
const keyboardRef: {
  current: ((event: ReactKeyboardEvent<HTMLTextAreaElement>) => boolean) | null;
} = { current: null };
const target = (
  provider: string,
  hostedInstanceId = `${provider}-computer`,
  instanceId = `${provider}-instance`
): ClientResourceTarget => ({
  provider,
  hostedInstanceId,
  instanceId,
  name: provider,
  computerLabel: "Selected computer",
  enabled: true,
  authenticationState: "authenticated"
});
const skill = {
  resourceId: `res_${"a".repeat(64)}`,
  kind: "skill" as const,
  name: "review",
  status: "ready" as const,
  availability: "available" as const,
  executionSupport: "koed_managed" as const,
  source: "user" as const,
  invocation: "native_skill" as const
};

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  vi.resetAllMocks();
  vi.useRealTimers();
});

async function render(scope: NativeSkillScope) {
  if (!root) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  await act(async () =>
    root!.render(
      <NativeSkillPicker
        scope={scope}
        query=""
        onSelect={onSelect}
        onDismiss={() => undefined}
        keyboardRef={keyboardRef}
      />
    )
  );
}

it("offers Claude Skills only when availability and managed execution are verified", async () => {
  vi.mocked(loadClientResourceTargets).mockResolvedValue([
    target("claude", "claude-computer", "claude-instance")
  ]);
  const managedSkill = {
    ...skill,
    name: "available-managed",
    resourceId: `res_${"a".repeat(64)}`
  };
  const catalog = {
    version: 1 as const,
    provider: "claude" as const,
    aiClientInstanceId: "claude-instance",
    hostedInstanceId: "claude-computer",
    computerLabel: "Selected computer",
    projectId: "selected-project",
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    resources: [
      managedSkill,
      {
        ...skill,
        name: "inventory-only",
        resourceId: `res_${"b".repeat(64)}`,
        executionSupport: "inventory_only" as const
      },
      {
        ...skill,
        name: "configured",
        resourceId: `res_${"c".repeat(64)}`,
        availability: "configured" as const
      }
    ]
  };
  vi.mocked(discoverClientResources).mockResolvedValue(catalog);
  await render({
    hostedInstanceId: "claude-computer",
    instanceId: "claude-instance",
    provider: "claude",
    projectId: "selected-project"
  });

  expect(discoverClientResources).toHaveBeenCalledWith(
    { hostedInstanceId: "claude-computer", projectId: "selected-project" },
    expect.any(AbortSignal)
  );
  const choices = container.querySelectorAll('[role="option"]');
  expect(choices).toHaveLength(1);
  expect(choices[0]?.textContent).toContain("/available-managed");
  expect(container.textContent).not.toContain("/inventory-only");
  expect(container.textContent).not.toContain("/configured");
  await act(async () => (choices[0] as HTMLButtonElement).click());
  expect(onSelect).toHaveBeenCalledWith(managedSkill, catalog.expiresAt);
});

it("does not offer Claude Skills that are inventory-only", async () => {
  vi.mocked(loadClientResourceTargets).mockResolvedValue([
    target("claude", "claude-computer", "claude-instance")
  ]);
  vi.mocked(discoverClientResources).mockResolvedValue({
    version: 1,
    provider: "claude",
    aiClientInstanceId: "claude-instance",
    hostedInstanceId: "claude-computer",
    computerLabel: "Selected computer",
    projectId: null,
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    resources: [
      {
        ...skill,
        availability: "available",
        executionSupport: "inventory_only",
        invocation: null
      }
    ]
  });
  await render({ hostedInstanceId: "claude-computer", projectId: null });
  expect(discoverClientResources).toHaveBeenCalledWith(
    { hostedInstanceId: "claude-computer", projectId: null },
    expect.any(AbortSignal)
  );
  expect(container.textContent).toContain("not verified");
  expect(container.querySelector('[role="option"]')).toBeNull();
  expect(onSelect).not.toHaveBeenCalled();
});

it("keeps native Codex Skill selection scoped to the selected computer and Project", async () => {
  vi.mocked(loadClientResourceTargets).mockResolvedValue([target("codex")]);
  vi.mocked(discoverClientResources).mockResolvedValue({
    version: 1,
    provider: "codex",
    aiClientInstanceId: "codex-instance",
    hostedInstanceId: "codex-computer",
    computerLabel: "Selected computer",
    projectId: "selected-project",
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    resources: [skill]
  });
  await render({
    hostedInstanceId: "codex-computer",
    projectId: "selected-project"
  });
  expect(discoverClientResources).toHaveBeenCalledWith(
    { hostedInstanceId: "codex-computer", projectId: "selected-project" },
    expect.any(AbortSignal)
  );
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[role="option"]')!.click()
  );
  expect(onSelect).toHaveBeenCalledWith(skill, expect.any(String));
});

it("rejects a stale Client identity even when its computer scope is selected", async () => {
  vi.mocked(loadClientResourceTargets).mockResolvedValue([target("codex")]);
  await render({
    hostedInstanceId: "codex-computer",
    instanceId: "replaced-codex-instance",
    provider: "codex",
    projectId: "selected-project"
  });
  expect(container.textContent).toContain("AI Client is no longer available");
  expect(discoverClientResources).not.toHaveBeenCalled();
  expect(container.querySelector('[role="option"]')).toBeNull();
});

it("does not offer configured, unknown, or inventory-only Skills for Koed chat", async () => {
  vi.mocked(loadClientResourceTargets).mockResolvedValue([target("codex")]);
  const catalog = {
    version: 1 as const,
    provider: "codex" as const,
    aiClientInstanceId: "codex-instance",
    hostedInstanceId: "codex-computer",
    computerLabel: "Selected computer",
    projectId: null,
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    resources: [
      {
        ...skill,
        resourceId: `res_${"b".repeat(64)}`,
        availability: "configured" as const,
        executionSupport: "koed_managed" as const
      },
      {
        ...skill,
        resourceId: `res_${"c".repeat(64)}`,
        availability: "unknown" as const,
        executionSupport: "koed_managed" as const
      },
      {
        ...skill,
        resourceId: `res_${"d".repeat(64)}`,
        availability: "available" as const,
        executionSupport: "inventory_only" as const,
        invocation: null
      }
    ]
  };
  vi.mocked(discoverClientResources).mockResolvedValue(catalog);
  await render({ hostedInstanceId: "codex-computer", projectId: null });
  expect(container.textContent).toContain("not verified");
  expect(container.textContent).not.toContain("/review");
  expect(container.querySelector('[role="option"]')).toBeNull();
  expect(onSelect).not.toHaveBeenCalled();
});

it("expires an already loaded catalog and disables stale Skill choices", async () => {
  vi.useFakeTimers();
  vi.mocked(loadClientResourceTargets).mockResolvedValue([target("codex")]);
  vi.mocked(discoverClientResources).mockResolvedValue({
    version: 1,
    provider: "codex",
    aiClientInstanceId: "codex-instance",
    hostedInstanceId: "codex-computer",
    computerLabel: "Selected computer",
    projectId: null,
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 500).toISOString(),
    resources: [skill]
  });
  await render({ hostedInstanceId: "codex-computer", projectId: null });
  expect(container.querySelector('[role="option"]')).not.toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(501);
  });
  expect(container.textContent).toContain("Skills list expired");
  expect(container.querySelector('[role="option"]')).toBeNull();
  expect(onSelect).not.toHaveBeenCalled();
});

it("does not resurrect an old A catalog or accept a late result after A → B → A", async () => {
  const codex = target("codex");
  const pi = target("pi");
  vi.mocked(loadClientResourceTargets).mockResolvedValue([codex, pi]);
  const catalogFor = (selected: ClientResourceTarget, resource: string) => ({
    version: 1 as const,
    provider: selected.provider as "codex" | "pi",
    aiClientInstanceId: selected.instanceId,
    hostedInstanceId: selected.hostedInstanceId,
    computerLabel: "Selected computer",
    projectId: null,
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    resources: [
      {
        ...skill,
        resourceId: `res_${(resource === "old-review"
          ? "a"
          : resource === "late-pi"
            ? "b"
            : "c"
        ).repeat(64)}`,
        name: resource
      }
    ]
  });
  const lateResults: Array<(catalog: ReturnType<typeof catalogFor>) => void> =
    [];
  let discoveryCount = 0;
  vi.mocked(discoverClientResources).mockImplementation(() => {
    discoveryCount += 1;
    if (discoveryCount === 1)
      return Promise.resolve(catalogFor(codex, "old-review"));
    return new Promise((resolve) => lateResults.push(resolve));
  });

  await render({
    hostedInstanceId: codex.hostedInstanceId,
    instanceId: codex.instanceId,
    provider: codex.provider,
    projectId: null
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(container.textContent).toContain("/old-review");

  await render({
    hostedInstanceId: pi.hostedInstanceId,
    instanceId: pi.instanceId,
    provider: pi.provider,
    projectId: null
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(discoveryCount).toBe(2);

  await render({
    hostedInstanceId: codex.hostedInstanceId,
    instanceId: codex.instanceId,
    provider: codex.provider,
    projectId: null
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(discoveryCount).toBe(3);
  expect(container.textContent).not.toContain("/old-review");
  expect(container.querySelector('[role="option"]')).toBeNull();
  keyboardRef.current?.({
    key: "Enter",
    shiftKey: false
  } as unknown as ReactKeyboardEvent<HTMLTextAreaElement>);
  expect(onSelect).not.toHaveBeenCalled();

  await act(async () => {
    lateResults[0]?.(catalogFor(pi, "late-pi"));
    await Promise.resolve();
  });
  expect(container.textContent).not.toContain("/late-pi");

  await act(async () => {
    lateResults[1]?.(catalogFor(codex, "fresh-review"));
    await Promise.resolve();
  });
  expect(container.textContent).toContain("/fresh-review");
  expect(container.textContent).not.toContain("/old-review");
});
