import { describe, expect, it } from "vitest";
import type { LocalEdgeUpstreamRegistry } from "@koed/shared";
import {
  createWorkspaceProjectShareContextLoader,
  projectShareBackendEligible
} from "./workspace-project-share-context.js";

const backend = (
  profile: "koed_managed_cloud" | "team_self_hosted" | "private_vps",
  provider = "workos"
) => ({
  id: "team",
  baseUrl: "https://team.example.test",
  profile,
  routePolicy: {
    teamWorkspaceRead: "enabled" as const,
    admin: "enabled" as const
  },
  credential: { status: "configured" },
  capabilities: {
    state: "validated" as const,
    expiresAt: "2030-01-01T00:00:00.000Z",
    payload: { auth: { providers: [provider] } },
    teamCollaborationV2: {
      state: "validated" as const,
      expiresAt: "2030-01-01T00:00:00.000Z"
    }
  }
});
const registry = (
  value: ReturnType<typeof backend>
): LocalEdgeUpstreamRegistry =>
  ({
    schemaVersion: 2,
    activeBackendId: value.id,
    backends: [value]
  }) as unknown as LocalEdgeUpstreamRegistry;

describe("HQ Share backend eligibility", () => {
  it("accepts verified hosted cloud and advanced Team self-hosted", () => {
    expect(
      projectShareBackendEligible(
        registry(backend("koed_managed_cloud")),
        "team",
        Date.UTC(2026, 9, 21)
      )
    ).toBe("koed_managed_cloud");
    expect(
      projectShareBackendEligible(
        registry(backend("team_self_hosted")),
        "team",
        Date.UTC(2026, 9, 21)
      )
    ).toBe("team_self_hosted");
  });
  it("refuses private VPS, local auth, stale capabilities, and inactive backends", () => {
    expect(
      projectShareBackendEligible(
        registry(backend("private_vps")),
        "team",
        Date.UTC(2026, 9, 21)
      )
    ).toBeNull();
    expect(
      projectShareBackendEligible(
        registry(backend("koed_managed_cloud", "local")),
        "team",
        Date.UTC(2026, 9, 21)
      )
    ).toBeNull();
    expect(
      projectShareBackendEligible(
        registry(backend("koed_managed_cloud")),
        "team",
        Date.UTC(2031, 0, 1)
      )
    ).toBeNull();
    expect(
      projectShareBackendEligible(
        registry(backend("koed_managed_cloud")),
        "other",
        Date.UTC(2026, 9, 21)
      )
    ).toBeNull();
  });
});

describe("HQ Share context loader", () => {
  it("checks the Personal profile again before returning a Team snapshot", async () => {
    let key = "first";
    const load = createWorkspaceProjectShareContextLoader({
      authority: async () => ({ key, ownerId: crypto.randomUUID() }),
      registryReader: () => registry(backend("koed_managed_cloud")),
      collaborationLoader: async () => {
        key = "second";
        return null;
      }
    });
    await expect(load()).rejects.toThrow("profile changed");
  });
});
