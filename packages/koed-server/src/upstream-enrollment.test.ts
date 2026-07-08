import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveKoedServerPaths } from "./paths.js";
import {
  refreshUpstreamBackendCapabilities,
  registerUpstreamBackend,
  updateUpstreamBackendRoutePolicy,
  type UpstreamBackendRegistry
} from "./upstream-registry.js";
import {
  cancelUpstreamEnrollment,
  disconnectUpstreamBackendEnrollment,
  getUpstreamEnrollmentStatus,
  startUpstreamEnrollment
} from "./upstream-enrollment.js";

const temps: string[] = [];

const tempPaths = () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-upstream-enroll-"));
  temps.push(root);
  return resolveKoedServerPaths({ KOED_HOME: root, KOED_REPO_ROOT: root });
};

const response = (ok: boolean, status: number, body: unknown): Response =>
  ({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  }) as Response;

const updateRegistry = (
  paths: ReturnType<typeof tempPaths>,
  update: (registry: UpstreamBackendRegistry) => void
) => {
  const registry = JSON.parse(
    readFileSync(paths.upstreamBackendsPath, "utf8")
  ) as UpstreamBackendRegistry;
  update(registry);
  writeFileSync(paths.upstreamBackendsPath, `${JSON.stringify(registry)}\n`);
};

const registerValidatedBackend = async () => {
  const paths = tempPaths();
  registerUpstreamBackend(paths, {
    id: "team-vps",
    url: "https://team.example.test",
    profile: "team-self-hosted"
  });
  await refreshUpstreamBackendCapabilities(paths, "team-vps", {
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    fetch: async () =>
      response(true, 200, {
        product: "koed",
        apiVersion: "v1",
        capabilitySchemaVersion: 3,
        deployment: { profile: "team_self_hosted" }
      })
  });
  return paths;
};

afterEach(() => {
  for (const path of temps.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("upstream enrollment orchestration", () => {
  it("fails closed until capabilities are fresh and route policy is explicit", async () => {
    const paths = await registerValidatedBackend();

    const noPolicy = startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:01:00.000Z")
    });

    expect(noPolicy).toMatchObject({
      ok: false,
      state: "failed",
      message: "Upstream backend team-vps has no enabled route-policy families."
    });

    updateUpstreamBackendRoutePolicy(paths, "team-vps", {
      teamWorkspaceRead: "enabled",
      sync: "enabled"
    });
    const started = startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:02:00.000Z"),
      randomId: () => "enroll-1"
    });

    expect(started).toMatchObject({
      ok: true,
      state: "pending",
      enrollment: {
        backendId: "team-vps",
        requestId: "enroll-1",
        requestedOperationFamilies: ["team_workspace_read", "sync"],
        activationUrl: null,
        credential: { status: "not_configured" }
      }
    });
    expect(readFileSync(paths.upstreamEnrollmentsPath, "utf8")).not.toMatch(
      /token|secret|password|bearer|cookie|authorization/i
    );
  });

  it("reports expired pending enrollment state deterministically", async () => {
    const paths = await registerValidatedBackend();
    updateUpstreamBackendRoutePolicy(paths, "team-vps", {
      teamWorkspaceRead: "enabled"
    });
    startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      randomId: () => "enroll-expiring"
    });

    const status = getUpstreamEnrollmentStatus(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:11:00.000Z")
    });

    expect(status).toMatchObject({
      ok: true,
      state: "expired",
      enrollment: {
        requestId: "enroll-expiring",
        state: "expired"
      }
    });
  });

  it("materializes exchanged state from configured credential metadata only", async () => {
    const paths = await registerValidatedBackend();
    updateUpstreamBackendRoutePolicy(paths, "team-vps", {
      teamWorkspaceRead: "enabled"
    });
    startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      randomId: () => "enroll-exchange"
    });
    updateRegistry(paths, (registry) => {
      registry.backends[0]!.credential = {
        status: "configured",
        reference: "keychain://team-vps"
      };
    });

    const status = getUpstreamEnrollmentStatus(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:01:00.000Z")
    });

    expect(status).toMatchObject({
      ok: true,
      state: "exchanged",
      enrollment: {
        credential: { status: "configured", reference: "keychain://team-vps" }
      }
    });
  });

  it("materializes configured credentials before restarting expired enrollment", async () => {
    const paths = await registerValidatedBackend();
    updateUpstreamBackendRoutePolicy(paths, "team-vps", {
      teamWorkspaceRead: "enabled"
    });
    startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      randomId: () => "enroll-approved-before-poll"
    });
    updateRegistry(paths, (registry) => {
      registry.backends[0]!.credential = {
        status: "configured",
        reference: "keychain://team-vps"
      };
    });

    const restarted = startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:11:00.000Z"),
      randomId: () => "new-enrollment"
    });

    expect(restarted).toMatchObject({
      ok: true,
      state: "exchanged",
      enrollment: {
        requestId: "enroll-approved-before-poll",
        state: "exchanged"
      }
    });
  });

  it("fails exchanged enrollment if backend credential is reset", async () => {
    const paths = await registerValidatedBackend();
    updateUpstreamBackendRoutePolicy(paths, "team-vps", {
      teamWorkspaceRead: "enabled"
    });
    startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      randomId: () => "enroll-reset"
    });
    updateRegistry(paths, (registry) => {
      registry.backends[0]!.credential = {
        status: "configured",
        reference: "keychain://team-vps"
      };
    });
    getUpstreamEnrollmentStatus(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:01:00.000Z")
    });
    updateRegistry(paths, (registry) => {
      registry.backends[0]!.credential = { status: "not_configured" };
    });

    const status = getUpstreamEnrollmentStatus(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:02:00.000Z")
    });

    expect(status).toMatchObject({
      ok: true,
      state: "failed",
      enrollment: {
        requestId: "enroll-reset",
        state: "failed",
        failureReason: "credential_reset",
        credential: { status: "not_configured" }
      }
    });
  });

  it("rejects admin-only browser-mediated enrollment", async () => {
    const paths = await registerValidatedBackend();
    updateUpstreamBackendRoutePolicy(paths, "team-vps", {
      admin: "enabled"
    });

    const started = startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });

    expect(started).toMatchObject({
      ok: false,
      state: "failed",
      message:
        "Upstream backend team-vps only enables admin routing, which cannot be enrolled through browser-mediated device enrollment."
    });
  });

  it("omits admin from mixed browser-mediated enrollment requests", async () => {
    const paths = await registerValidatedBackend();
    updateUpstreamBackendRoutePolicy(paths, "team-vps", {
      admin: "enabled",
      teamWorkspaceRead: "enabled"
    });

    const started = startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      randomId: () => "enroll-no-admin"
    });

    expect(started).toMatchObject({
      ok: true,
      state: "pending",
      enrollment: {
        requestedOperationFamilies: ["team_workspace_read"]
      }
    });
  });

  it("does not cancel terminal enrollment state", async () => {
    const paths = await registerValidatedBackend();
    updateUpstreamBackendRoutePolicy(paths, "team-vps", {
      teamWorkspaceRead: "enabled"
    });
    startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      randomId: () => "enroll-terminal"
    });
    updateRegistry(paths, (registry) => {
      registry.backends[0]!.credential = {
        status: "configured",
        reference: "keychain://team-vps"
      };
    });

    const canceled = cancelUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:01:00.000Z")
    });

    expect(canceled).toMatchObject({
      ok: true,
      state: "exchanged",
      enrollment: { requestId: "enroll-terminal", state: "exchanged" }
    });
  });

  it("cancels pending enrollment without touching backend registration", async () => {
    const paths = await registerValidatedBackend();
    updateUpstreamBackendRoutePolicy(paths, "team-vps", {
      teamWorkspaceRead: "enabled"
    });
    startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:00:30.000Z"),
      randomId: () => "enroll-cancel"
    });

    const canceled = cancelUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:01:00.000Z")
    });

    expect(canceled).toMatchObject({
      ok: true,
      state: "canceled",
      backend: { id: "team-vps" },
      enrollment: { requestId: "enroll-cancel", state: "canceled" }
    });
  });

  it("disconnects by disabling route policy and marking local enrollment revoked", async () => {
    const paths = await registerValidatedBackend();
    updateUpstreamBackendRoutePolicy(paths, "team-vps", {
      teamWorkspaceRead: "enabled",
      sync: "enabled"
    });
    startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:00:30.000Z"),
      randomId: () => "enroll-disconnect"
    });

    const disconnected = disconnectUpstreamBackendEnrollment(
      paths,
      "team-vps",
      {
        now: () => new Date("2026-01-01T00:03:00.000Z")
      }
    );

    expect(disconnected).toMatchObject({
      ok: true,
      state: "revoked",
      backend: {
        routePolicy: {
          personalMemoryRead: "disabled",
          teamWorkspaceRead: "disabled",
          shareGrantManagement: "disabled",
          captureWrites: "disabled",
          sync: "disabled",
          admin: "disabled"
        },
        credential: { status: "revoked" }
      },
      enrollment: {
        requestId: "enroll-disconnect",
        state: "revoked",
        credential: { status: "revoked" }
      }
    });
  });
});
