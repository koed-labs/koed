// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { ClientResourceCatalog } from "@/lib/client-resources-client";
import {
  discoverClientResources,
  loadClientResourceTargets
} from "@/lib/client-resources-client";
import { ClientResourcesView } from "./ClientResourcesView";

vi.mock("@/lib/client-resources-client", async (original) => ({
  ...(await original<object>()),
  discoverClientResources: vi.fn(),
  loadClientResourceTargets: vi.fn()
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement;
const client = {
  hostedInstanceId: "claude-on-owner-device",
  instanceId: "claude-instance",
  provider: "claude",
  name: "Claude Code",
  computerLabel: "Owner computer",
  enabled: true,
  authenticationState: "unknown"
};
const resource = (
  name: string,
  availability: "available" | "configured" | "unknown",
  executionSupport: "inventory_only" | "unknown",
  suffix: string
) => ({
  resourceId: `res_${suffix.repeat(64)}`,
  kind: "skill" as const,
  name,
  status: "unavailable" as const,
  availability,
  executionSupport,
  source: "configured" as const,
  invocation: null
});
const catalog: ClientResourceCatalog = {
  version: 1,
  provider: "claude",
  aiClientInstanceId: "claude-instance",
  hostedInstanceId: "claude-on-owner-device",
  computerLabel: "Owner computer",
  projectId: null,
  observedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  resources: [
    resource("installed-skill", "available", "inventory_only", "a"),
    resource("configured-plugin-skill", "configured", "unknown", "b"),
    resource("unknown-skill", "unknown", "inventory_only", "c")
  ]
};

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  vi.resetAllMocks();
});

it("separates native Client availability from verified Koed use", async () => {
  vi.mocked(loadClientResourceTargets).mockResolvedValue([client]);
  vi.mocked(discoverClientResources).mockResolvedValue(catalog);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<ClientResourcesView kind="skills" />));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  const rows = Array.from(container.querySelectorAll(".divide-y > div"));
  expect(rows).toHaveLength(3);
  expect(rows[0]?.textContent).toContain("Available in Client");
  expect(rows[0]?.textContent).toContain(
    "Inventory only · not usable in Koed chat"
  );
  expect(rows[0]?.textContent).not.toContain("Usable in Koed chat");
  expect(rows[1]?.textContent).toContain("Installed/configured");
  expect(rows[1]?.textContent).toContain("Use in Koed chat not verified");
  expect(rows[2]?.textContent).toContain("Status unknown");
  expect(rows[2]?.textContent).not.toContain("Available in Client");
  expect(rows[2]?.textContent).toContain("Inventory only");
});

it("does not report disabled Clients or unknown authentication as ready", async () => {
  vi.mocked(loadClientResourceTargets).mockResolvedValue([
    { ...client, enabled: false, authenticationState: "unknown" }
  ]);
  vi.mocked(discoverClientResources).mockResolvedValue(catalog);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<ClientResourcesView kind="skills" />));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(container.textContent).toContain("disabled in Koed");
  expect(container.textContent).not.toContain("Available in Client");
  expect(discoverClientResources).not.toHaveBeenCalled();
});

it("does not infer a disabled Client from an unknown enabled state", async () => {
  vi.mocked(loadClientResourceTargets).mockResolvedValue([
    { ...client, enabled: null }
  ]);
  vi.mocked(discoverClientResources).mockResolvedValue(catalog);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<ClientResourcesView kind="skills" />));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(discoverClientResources).toHaveBeenCalledWith(
    { hostedInstanceId: client.hostedInstanceId, projectId: null },
    expect.any(AbortSignal)
  );
  expect(container.textContent).not.toContain("Client disabled");
  expect(container.textContent).toContain("Client enabled state unknown");
});

it("starts one discovery after manual refresh reloads fresh target objects", async () => {
  vi.mocked(loadClientResourceTargets).mockImplementation(async () => [
    { ...client }
  ]);
  vi.mocked(discoverClientResources).mockResolvedValue(catalog);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);

  const flushViewUpdates = async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  };
  await act(async () => {
    root!.render(<ClientResourcesView kind="skills" />);
    await flushViewUpdates();
  });
  expect(loadClientResourceTargets).toHaveBeenCalledTimes(1);
  expect(discoverClientResources).toHaveBeenCalledTimes(1);

  const refresh = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === "Refresh"
  );
  expect(refresh).toBeDefined();
  await act(async () => {
    refresh!.click();
    await flushViewUpdates();
  });

  expect(loadClientResourceTargets).toHaveBeenCalledTimes(2);
  expect(discoverClientResources).toHaveBeenCalledTimes(2);
});
