import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readLocalEdgeClientCredentialAuthorization,
  readUpstreamCredentialAuthorization
} from "@koed/shared";
import { resolveKoedServerPaths } from "./paths.js";
import { ensureDeviceIdentity } from "./device-identity.js";
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
  invalidateUpstreamEnrollmentReferences,
  startUpstreamEnrollment
} from "./upstream-enrollment.js";

const temps: string[] = [];
const proofTemps: string[] = [];
const proofEnvRestores: Array<string | undefined> = [];

const tempPaths = () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-upstream-enroll-"));
  const proofRoot = mkdtempSync(
    resolve(tmpdir(), "koed-upstream-enroll-proof-")
  );
  proofEnvRestores.push(process.env.KOED_DEVICE_PROOF_DIR);
  process.env.KOED_DEVICE_PROOF_DIR = resolve(proofRoot, "proof");
  temps.push(root);
  proofTemps.push(proofRoot);
  return resolveKoedServerPaths({ KOED_HOME: root, KOED_REPO_ROOT: root });
};

const response = (ok: boolean, status: number, body: unknown): Response =>
  ({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  }) as Response;

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const deferredCredentialStatusFetch = () => {
  const requested = deferred<void>();
  const release = deferred<void>();
  const fallback = enrollmentFetch();
  return {
    requested: requested.promise,
    release: () => release.resolve(),
    fetch: async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1]
    ): Promise<Response> => {
      const url =
        typeof input === "string" || input instanceof URL ? input : input.url;
      if (
        init?.method === "GET" &&
        new URL(String(url)).pathname ===
          "/v1/local-edge/device-credentials/status"
      ) {
        requested.resolve();
        await release.promise;
        return response(true, 200, { ok: true });
      }
      return fallback(input, init);
    }
  };
};

const deferredChallengeCreationFetch = () => {
  const requested = deferred<void>();
  const release = deferred<void>();
  const fallback = enrollmentFetch();
  return {
    requested: requested.promise,
    release: () => release.resolve(),
    fetch: async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1]
    ): Promise<Response> => {
      const url =
        typeof input === "string" || input instanceof URL ? input : input.url;
      if (
        init?.method === "POST" &&
        new URL(String(url)).pathname ===
          "/v1/local-edge/device-enrollments/challenges"
      ) {
        requested.resolve();
        await release.promise;
      }
      return fallback(input, init);
    }
  };
};

const enrollmentFetch =
  (
    status: "pending" | "approved" | "denied" | "expired" = "pending",
    credentialActive: boolean | "unknown" = false
  ) =>
  async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ): Promise<Response> => {
    expect(init?.redirect).toBe("error");
    const url =
      typeof input === "string" || input instanceof URL ? input : input.url;
    const parsed = new URL(String(url));
    if (
      init?.method === "POST" &&
      parsed.pathname === "/v1/local-edge/device-enrollments/challenges"
    ) {
      const body = JSON.parse(String(init.body ?? "{}")) as {
        pending_credential?: { credential_key_id?: string };
      };
      return response(true, 200, {
        challenge: {
          id: `challenge-${body.pending_credential?.credential_key_id ?? "unknown"}`,
          status: "pending"
        }
      });
    }
    if (
      init?.method === "GET" &&
      parsed.pathname.startsWith(
        "/v1/local-edge/device-enrollments/challenges/"
      )
    ) {
      return response(true, 200, { challenge: { status } });
    }
    if (
      init?.method === "GET" &&
      parsed.pathname === "/v1/local-edge/device-credentials/status"
    ) {
      if (credentialActive === "unknown") {
        return response(false, 503, { error: "temporarily unavailable" });
      }
      if (credentialActive) {
        return response(true, 200, { ok: true });
      }
      return response(false, 401, { error: "credential not active" });
    }
    return response(false, 404, {
      error: `Unhandled ${init?.method} ${parsed.pathname}`
    });
  };

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
    rmSync(`${path}-proof-root`, { recursive: true, force: true });
  }
  for (const path of proofTemps.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
  const previousProofDir = proofEnvRestores.pop();
  if (previousProofDir === undefined) {
    delete process.env.KOED_DEVICE_PROOF_DIR;
  } else {
    process.env.KOED_DEVICE_PROOF_DIR = previousProofDir;
  }
});

describe("upstream enrollment orchestration", () => {
  it("uses verified device instance ID for enrollment and gates unhealthy polling", async () => {
    const paths = await registerValidatedBackend();
    updateUpstreamBackendRoutePolicy(paths, "team-vps", {
      teamWorkspaceRead: "enabled"
    });
    const identity = await ensureDeviceIdentity(paths);
    let enrolledDeviceId: string | null = null;
    const enrollmentFetchWithVerifiedDevice = async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1]
    ) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (
        init?.method === "POST" &&
        new URL(url).pathname === "/v1/local-edge/device-enrollments/challenges"
      ) {
        const body: unknown = JSON.parse(String(init.body));
        enrolledDeviceId =
          body &&
          typeof body === "object" &&
          "device_instance_id" in body &&
          typeof body.device_instance_id === "string"
            ? body.device_instance_id
            : null;
      }
      return enrollmentFetch()(input, init);
    };
    const started = await startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:01:00.000Z"),
      randomId: () => "verified-device-id",
      fetch: enrollmentFetchWithVerifiedDevice
    });

    expect(started.ok, started.message).toBe(true);
    expect(started.state).toBe("pending");
    expect(enrolledDeviceId).toBe(identity.deviceInstanceId);

    rmSync(`${paths.koedHome}-proof`, { recursive: true, force: true });
    rmSync(`${paths.koedHome}-proof-root`, { recursive: true, force: true });
    rmSync(process.env.KOED_DEVICE_PROOF_DIR!, {
      recursive: true,
      force: true
    });
    const blockedFetch = vi.fn();
    await expect(
      getUpstreamEnrollmentStatus(paths, "team-vps", {
        now: () => new Date("2026-01-01T00:02:00.000Z"),
        fetch: blockedFetch
      })
    ).resolves.toMatchObject({ ok: false, state: "failed" });
    expect(blockedFetch).not.toHaveBeenCalled();
  });

  it("fails closed until capabilities are fresh and route policy is explicit", async () => {
    const paths = await registerValidatedBackend();

    const noPolicy = await startUpstreamEnrollment(paths, "team-vps", {
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
    const started = await startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:02:00.000Z"),
      randomId: () => "enroll-1",
      fetch: enrollmentFetch()
    });

    expect(started).toMatchObject({
      ok: true,
      state: "pending",
      enrollment: {
        backendId: "team-vps",
        requestId: "enroll-1",
        requestedOperationFamilies: ["team_workspace_read", "sync"],
        credential: {
          status: "unknown"
        }
      }
    });
    expect(started.enrollment?.activationUrl).toMatch(
      /^https:\/\/team\.example\.test\/device-enrollment\/challenge-koed_/
    );
    expect(started.enrollment?.credential.reference).toMatch(
      /^keychain:\/\/koed-upstream\/team-vps\//
    );
    expect(readFileSync(paths.upstreamEnrollmentsPath, "utf8")).not.toMatch(
      /token|verifier|password|bearer|cookie|authorization/i
    );
  });

  it("reports expired pending enrollment state deterministically", async () => {
    const paths = await registerValidatedBackend();
    updateUpstreamBackendRoutePolicy(paths, "team-vps", {
      teamWorkspaceRead: "enabled"
    });
    await startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      randomId: () => "enroll-expiring",
      fetch: enrollmentFetch()
    });

    const status = await getUpstreamEnrollmentStatus(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:11:00.000Z"),
      fetch: enrollmentFetch()
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

  it("materializes exchanged state from active upstream credential status", async () => {
    const paths = await registerValidatedBackend();
    updateUpstreamBackendRoutePolicy(paths, "team-vps", {
      teamWorkspaceRead: "enabled"
    });
    const started = await startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      randomId: () => "enroll-exchange",
      fetch: enrollmentFetch()
    });
    const reference = started.enrollment!.credential.reference!;
    updateRegistry(paths, (registry) => {
      registry.backends[0]!.credential = {
        status: "configured",
        reference
      };
    });

    const status = await getUpstreamEnrollmentStatus(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:01:00.000Z"),
      fetch: enrollmentFetch("pending", true)
    });

    expect(status).toMatchObject({
      ok: true,
      state: "exchanged",
      enrollment: {
        credential: { status: "configured", reference }
      }
    });
  });

  it("keeps exchanged credentials during transient status failures", async () => {
    const paths = await registerValidatedBackend();
    updateUpstreamBackendRoutePolicy(paths, "team-vps", {
      teamWorkspaceRead: "enabled"
    });
    const started = await startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      randomId: () => "enroll-transient-status",
      fetch: enrollmentFetch()
    });
    const reference = started.enrollment!.credential.reference!;
    updateRegistry(paths, (registry) => {
      registry.backends[0]!.credential = { status: "configured", reference };
    });

    const status = await getUpstreamEnrollmentStatus(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:01:00.000Z"),
      fetch: enrollmentFetch("pending", "unknown")
    });

    expect(status).toMatchObject({
      ok: false,
      state: "exchanged",
      enrollment: {
        failureReason: "credential_status_unavailable",
        credential: { status: "configured", reference }
      }
    });
    expect(
      readUpstreamCredentialAuthorization(paths.koedHome, reference)
    ).not.toBeNull();
    expect(
      readLocalEdgeClientCredentialAuthorization(paths.koedHome, "team-vps")
    ).not.toBeNull();
  });

  it("materializes configured credentials before restarting expired enrollment", async () => {
    const paths = await registerValidatedBackend();
    updateUpstreamBackendRoutePolicy(paths, "team-vps", {
      teamWorkspaceRead: "enabled"
    });
    const started = await startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      randomId: () => "enroll-approved-before-poll",
      fetch: enrollmentFetch()
    });
    const reference = started.enrollment!.credential.reference!;
    updateRegistry(paths, (registry) => {
      registry.backends[0]!.credential = {
        status: "configured",
        reference
      };
    });

    const restarted = await startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:11:00.000Z"),
      randomId: () => "new-enrollment",
      fetch: enrollmentFetch("pending", true)
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
    const started = await startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      randomId: () => "enroll-reset",
      fetch: enrollmentFetch()
    });
    const reference = started.enrollment!.credential.reference!;
    updateRegistry(paths, (registry) => {
      registry.backends[0]!.credential = {
        status: "configured",
        reference
      };
    });
    await getUpstreamEnrollmentStatus(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:01:00.000Z"),
      fetch: enrollmentFetch("pending", true)
    });
    updateRegistry(paths, (registry) => {
      registry.backends[0]!.credential = { status: "not_configured" };
    });

    const status = await getUpstreamEnrollmentStatus(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:02:00.000Z"),
      fetch: enrollmentFetch()
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

    const started = await startUpstreamEnrollment(paths, "team-vps", {
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

    const started = await startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      randomId: () => "enroll-no-admin",
      fetch: enrollmentFetch()
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
    await startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      randomId: () => "enroll-terminal",
      fetch: enrollmentFetch()
    });
    updateRegistry(paths, (registry) => {
      registry.backends[0]!.credential = {
        status: "configured",
        reference: "keychain://team-vps"
      };
    });

    const canceled = await cancelUpstreamEnrollment(paths, "team-vps", {
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
    await startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:00:30.000Z"),
      randomId: () => "enroll-cancel",
      fetch: enrollmentFetch()
    });

    const canceled = await cancelUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:01:00.000Z")
    });

    expect(canceled).toMatchObject({
      ok: true,
      state: "canceled",
      backend: { id: "team-vps" },
      enrollment: { requestId: "enroll-cancel", state: "canceled" }
    });
  });

  it("disables local credentials and records pending remote revocation without self-revoking", async () => {
    const paths = await registerValidatedBackend();
    updateUpstreamBackendRoutePolicy(paths, "team-vps", {
      teamWorkspaceRead: "enabled"
    });
    const started = await startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:01:00.000Z"),
      fetch: enrollmentFetch()
    });
    const reference = started.enrollment!.credential.reference!;

    await expect(
      invalidateUpstreamEnrollmentReferences(paths, {
        now: () => new Date("2026-01-01T00:02:00.000Z")
      })
    ).resolves.toEqual({ pendingRemoteRevocation: true });
    expect(
      readUpstreamCredentialAuthorization(paths.koedHome, reference)
    ).toBeNull();
    expect(
      readLocalEdgeClientCredentialAuthorization(paths.koedHome, "team-vps")
    ).toBeNull();
  });

  it("disconnects by disabling route policy and marking local enrollment revoked", async () => {
    const paths = await registerValidatedBackend();
    updateUpstreamBackendRoutePolicy(paths, "team-vps", {
      teamWorkspaceRead: "enabled",
      sync: "enabled"
    });
    await startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:00:30.000Z"),
      randomId: () => "enroll-disconnect",
      fetch: enrollmentFetch()
    });

    const disconnected = await disconnectUpstreamBackendEnrollment(
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
    expect(
      readLocalEdgeClientCredentialAuthorization(paths.koedHome, "team-vps")
    ).toBeNull();

    updateUpstreamBackendRoutePolicy(paths, "team-vps", {
      teamWorkspaceRead: "enabled"
    });
    const restarted = await startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:04:00.000Z"),
      randomId: () => "enroll-after-disconnect",
      fetch: enrollmentFetch()
    });
    expect(restarted).toMatchObject({
      ok: true,
      state: "pending",
      enrollment: {
        requestId: "enroll-after-disconnect",
        state: "pending"
      }
    });
    expect(restarted.enrollment?.activationUrl).toContain(
      "/device-enrollment/"
    );
    expect(
      readLocalEdgeClientCredentialAuthorization(paths.koedHome, "team-vps")
    ).not.toBeNull();
  });

  it("does not let a late status response undo a disconnect", async () => {
    const paths = await registerValidatedBackend();
    updateUpstreamBackendRoutePolicy(paths, "team-vps", {
      teamWorkspaceRead: "enabled"
    });
    const started = await startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      randomId: () => "enroll-before-disconnect",
      fetch: enrollmentFetch()
    });
    const reference = started.enrollment!.credential.reference!;
    const pendingStatus = deferredCredentialStatusFetch();
    const statusPromise = getUpstreamEnrollmentStatus(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:01:00.000Z"),
      fetch: pendingStatus.fetch
    });
    await pendingStatus.requested;

    await disconnectUpstreamBackendEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:02:00.000Z")
    });
    pendingStatus.release();

    await expect(statusPromise).resolves.toMatchObject({
      ok: true,
      state: "revoked",
      enrollment: {
        requestId: "enroll-before-disconnect",
        state: "revoked",
        credential: { status: "revoked" }
      }
    });
    expect(
      readUpstreamCredentialAuthorization(paths.koedHome, reference)
    ).toBeNull();
    expect(
      readLocalEdgeClientCredentialAuthorization(paths.koedHome, "team-vps")
    ).toBeNull();
  });

  it("does not let a late status response overwrite a replacement enrollment", async () => {
    const paths = await registerValidatedBackend();
    updateUpstreamBackendRoutePolicy(paths, "team-vps", {
      teamWorkspaceRead: "enabled"
    });
    const original = await startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      randomId: () => "original-enrollment",
      fetch: enrollmentFetch()
    });
    const originalReference = original.enrollment!.credential.reference!;
    const pendingStatus = deferredCredentialStatusFetch();
    const statusPromise = getUpstreamEnrollmentStatus(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:01:00.000Z"),
      fetch: pendingStatus.fetch
    });
    await pendingStatus.requested;

    await disconnectUpstreamBackendEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:02:00.000Z")
    });
    updateUpstreamBackendRoutePolicy(paths, "team-vps", {
      teamWorkspaceRead: "enabled"
    });
    const replacement = await startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:03:00.000Z"),
      randomId: () => "replacement-enrollment",
      fetch: enrollmentFetch()
    });
    const replacementReference = replacement.enrollment!.credential.reference!;
    pendingStatus.release();

    await expect(statusPromise).resolves.toMatchObject({
      ok: true,
      state: "pending",
      enrollment: {
        requestId: "replacement-enrollment",
        state: "pending",
        credential: { reference: replacementReference }
      }
    });
    expect(
      readUpstreamCredentialAuthorization(paths.koedHome, originalReference)
    ).toBeNull();
    expect(
      readUpstreamCredentialAuthorization(paths.koedHome, replacementReference)
    ).not.toBeNull();
  });

  it("does not persist a new enrollment after a concurrent disconnect", async () => {
    const paths = await registerValidatedBackend();
    updateUpstreamBackendRoutePolicy(paths, "team-vps", {
      teamWorkspaceRead: "enabled"
    });
    const pendingChallenge = deferredChallengeCreationFetch();
    const startPromise = startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      randomId: () => "enrollment-starting",
      fetch: pendingChallenge.fetch
    });
    await pendingChallenge.requested;

    await disconnectUpstreamBackendEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:01:00.000Z"),
      randomId: () => "disconnect-record"
    });
    pendingChallenge.release();

    await expect(startPromise).resolves.toMatchObject({
      ok: true,
      state: "revoked",
      enrollment: { requestId: "disconnect-record", state: "revoked" }
    });
    expect(
      readLocalEdgeClientCredentialAuthorization(paths.koedHome, "team-vps")
    ).toBeNull();
  });
});
