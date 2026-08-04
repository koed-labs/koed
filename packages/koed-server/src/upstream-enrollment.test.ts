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
import { completeUpstreamDisconnectCleanup } from "./upstream-disconnect-cleanup.js";
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
  readUpstreamEnrollmentBinding,
  startUpstreamEnrollment
} from "./upstream-enrollment.js";

const remotePrincipalUserId = "11111111-1111-4111-8111-111111111111";
const remoteDeviceCredentialId = "22222222-2222-4222-8222-222222222222";
const activeCredentialPayload = {
  ok: true,
  user: { id: remotePrincipalUserId },
  credential: { id: remoteDeviceCredentialId }
};

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
        return response(true, 200, activeCredentialPayload);
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
        return response(true, 200, activeCredentialPayload);
      }
      return response(false, 401, { error: "credential not active" });
    }
    if (
      init?.method === "DELETE" &&
      parsed.pathname === "/v1/local-edge/device-credentials/current"
    ) {
      if (credentialActive === "unknown") {
        return response(false, 503, { error: "temporarily unavailable" });
      }
      return credentialActive
        ? response(true, 200, { revoked: true })
        : response(false, 401, { error: "credential not active" });
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

const validateBackendCapabilities = async (
  paths: ReturnType<typeof tempPaths>,
  options: { collaboration?: boolean } = {}
) => {
  await refreshUpstreamBackendCapabilities(paths, "team-vps", {
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    fetch: async () =>
      response(true, 200, {
        product: "koed",
        apiVersion: "v1",
        capabilitySchemaVersion: 6,
        deployment: { profile: "team_self_hosted" },
        capabilities:
          options.collaboration === false
            ? {}
            : { "memory.collaboration": { availability: "partial" } }
      })
  });
};

const registerValidatedBackend = async (
  options: { collaboration?: boolean } = {}
) => {
  const paths = tempPaths();
  registerUpstreamBackend(paths, {
    id: "team-vps",
    url: "https://team.example.test",
    profile: "team-self-hosted"
  });
  await validateBackendCapabilities(paths, options);
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

  it("persists a non-authoritative prepared transaction before the remote challenge request", async () => {
    const paths = await registerValidatedBackend();
    updateUpstreamBackendRoutePolicy(paths, "team-vps", {
      teamWorkspaceRead: "enabled"
    });
    const pendingChallenge = deferredChallengeCreationFetch();
    const startPromise = startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      randomId: () => "durable-before-remote",
      fetch: pendingChallenge.fetch
    });

    await pendingChallenge.requested;
    const persisted = JSON.parse(
      readFileSync(paths.upstreamEnrollmentsPath, "utf8")
    ) as {
      enrollments: Array<{
        requestId: string;
        state: string;
        activeCredentialReference?: string;
        pendingCredentialReference?: string;
        transactionState: {
          id: string;
          generation: number;
          kind: string;
          phase: string;
        };
      }>;
    };
    expect(persisted.enrollments.at(-1)).toMatchObject({
      requestId: "durable-before-remote",
      state: "pending",
      transactionState: {
        id: "durable-before-remote",
        generation: 1,
        kind: "initial",
        phase: "awaiting_remote"
      }
    });
    expect(persisted.enrollments.at(-1)?.pendingCredentialReference).toMatch(
      /^keychain:\/\/koed-upstream\/team-vps\//
    );
    expect(persisted.enrollments.at(-1)).not.toHaveProperty(
      "activeCredentialReference"
    );
    expect(readUpstreamEnrollmentBinding(paths, "team-vps")).toBeNull();

    pendingChallenge.release();
    await expect(startPromise).resolves.toMatchObject({
      ok: true,
      state: "pending"
    });
  });

  it.each([
    "stage_upstream_credential",
    "stage_local_client_credential",
    "stage_registry_credential",
    "commit_prepared_state"
  ])("compensates an interrupted %s boundary on retry", async (boundary) => {
    const paths = await registerValidatedBackend();
    updateUpstreamBackendRoutePolicy(paths, "team-vps", {
      teamWorkspaceRead: "enabled"
    });
    let injected = false;
    const started = await startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      randomId: () => `interrupted-${boundary}`,
      fetch: enrollmentFetch(),
      beforeEnrollmentEffect: (candidate) => {
        if (!injected && candidate === boundary) {
          injected = true;
          throw new Error(`interrupted at ${boundary}`);
        }
      }
    });

    expect(started).toMatchObject({ ok: false, state: "failed" });
    const interrupted = JSON.parse(
      readFileSync(paths.upstreamEnrollmentsPath, "utf8")
    ) as {
      enrollments: Array<{
        transactionState: { phase: string; pendingEffect: string | null };
      }>;
    };
    expect(interrupted.enrollments.at(-1)?.transactionState).toEqual(
      expect.objectContaining({
        phase: "recovery_required",
        pendingEffect: "stage_pending_custody"
      })
    );

    const recovered = await getUpstreamEnrollmentStatus(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:01:00.000Z"),
      fetch: enrollmentFetch()
    });
    expect(recovered).toMatchObject({
      ok: false,
      state: "failed",
      backend: { credential: { status: "not_configured" } },
      enrollment: {
        failureReason: "prepared_effect_compensated",
        credential: { status: "not_configured" }
      }
    });
    expect(
      readLocalEdgeClientCredentialAuthorization(paths.koedHome, "team-vps")
    ).toBeNull();
    expect(
      readUpstreamCredentialAuthorization(
        paths.koedHome,
        started.enrollment?.credential.reference
      )
    ).toBeNull();

    await expect(
      getUpstreamEnrollmentStatus(paths, "team-vps", {
        now: () => new Date("2026-01-01T00:02:00.000Z"),
        fetch: enrollmentFetch()
      })
    ).resolves.toMatchObject({ state: "failed" });
  });

  it.each([
    "abort_delete_pending_credential",
    "abort_delete_local_client_credential",
    "abort_clear_registry_credential",
    "commit_enrollment_state"
  ])("resumes an interrupted %s abort idempotently", async (boundary) => {
    const paths = await registerValidatedBackend();
    updateUpstreamBackendRoutePolicy(paths, "team-vps", {
      teamWorkspaceRead: "enabled"
    });
    await startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      randomId: () => `abort-${boundary}`,
      fetch: enrollmentFetch()
    });
    let injected = false;
    await expect(
      getUpstreamEnrollmentStatus(paths, "team-vps", {
        now: () => new Date("2026-01-01T00:01:00.000Z"),
        fetch: enrollmentFetch("denied", false),
        beforeEnrollmentEffect: (candidate) => {
          if (!injected && candidate === boundary) {
            injected = true;
            throw new Error(`interrupted at ${boundary}`);
          }
        }
      })
    ).rejects.toThrow(`interrupted at ${boundary}`);

    await expect(
      getUpstreamEnrollmentStatus(paths, "team-vps", {
        now: () => new Date("2026-01-01T00:02:00.000Z"),
        fetch: enrollmentFetch("denied", false)
      })
    ).resolves.toMatchObject({
      state: "denied",
      backend: { credential: { status: "not_configured" } }
    });
    await expect(
      getUpstreamEnrollmentStatus(paths, "team-vps", {
        now: () => new Date("2026-01-01T00:03:00.000Z"),
        fetch: enrollmentFetch("denied", false)
      })
    ).resolves.toMatchObject({ state: "denied" });
  });

  it.each(["commit_registry_credential", "commit_enrollment_state"])(
    "resumes an interrupted %s commit idempotently",
    async (boundary) => {
      const paths = await registerValidatedBackend();
      updateUpstreamBackendRoutePolicy(paths, "team-vps", {
        teamWorkspaceRead: "enabled"
      });
      await startUpstreamEnrollment(paths, "team-vps", {
        now: () => new Date("2026-01-01T00:00:00.000Z"),
        randomId: () => `commit-${boundary}`,
        fetch: enrollmentFetch()
      });
      let injected = false;
      const interrupted = await getUpstreamEnrollmentStatus(paths, "team-vps", {
        now: () => new Date("2026-01-01T00:01:00.000Z"),
        fetch: enrollmentFetch("pending", true),
        beforeEnrollmentEffect: (candidate) => {
          if (!injected && candidate === boundary) {
            injected = true;
            throw new Error(`interrupted at ${boundary}`);
          }
        }
      }).catch((error: unknown) => error);
      if (boundary === "commit_registry_credential") {
        expect(interrupted).toMatchObject({ ok: false, state: "pending" });
      } else {
        expect(interrupted).toBeInstanceOf(Error);
      }

      await expect(
        getUpstreamEnrollmentStatus(paths, "team-vps", {
          now: () => new Date("2026-01-01T00:02:00.000Z"),
          fetch: enrollmentFetch("pending", true)
        })
      ).resolves.toMatchObject({
        ok: true,
        state: "exchanged"
      });
      expect(readUpstreamEnrollmentBinding(paths, "team-vps")).not.toBeNull();
    }
  );

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
      personalCollaboration: "enabled",
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
        requestedOperationFamilies: [
          "personal_collaboration_read",
          "personal_collaboration_write",
          "team_workspace_read",
          "team_chat_read",
          "team_chat_write",
          "sync"
        ],
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
    expect(
      readLocalEdgeClientCredentialAuthorization(paths.koedHome, "team-vps")
        ?.operationFamilies
    ).toEqual([
      "personal_collaboration_read",
      "personal_collaboration_write",
      "team_workspace_read",
      "team_chat_read",
      "team_chat_write"
    ]);
    expect(readFileSync(paths.upstreamEnrollmentsPath, "utf8")).not.toMatch(
      /token|verifier|password|bearer|cookie|authorization/i
    );
  });

  it("does not grant collaboration scopes when the upstream omits that capability", async () => {
    const paths = await registerValidatedBackend({ collaboration: false });
    updateUpstreamBackendRoutePolicy(paths, "team-vps", {
      teamWorkspaceRead: "enabled"
    });

    const started = await startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:02:00.000Z"),
      randomId: () => "enroll-without-chat",
      fetch: enrollmentFetch()
    });

    expect(started.enrollment?.requestedOperationFamilies).toEqual([
      "team_workspace_read"
    ]);
  });

  it("admits shared-memory control locally without copying remote-only authority", async () => {
    const paths = await registerValidatedBackend();
    updateUpstreamBackendRoutePolicy(paths, "team-vps", {
      teamWorkspaceRead: "enabled",
      shareGrantManagement: "enabled",
      sync: "enabled",
      admin: "enabled"
    });

    await startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:02:00.000Z"),
      randomId: () => "enroll-shared-memory",
      fetch: enrollmentFetch()
    });

    expect(
      readLocalEdgeClientCredentialAuthorization(paths.koedHome, "team-vps")
        ?.operationFamilies
    ).toEqual([
      "team_workspace_read",
      "team_chat_read",
      "team_chat_write",
      "share_grant_management"
    ]);
  });

  it("uses the browser activation URL returned by the Team backend", async () => {
    const paths = await registerValidatedBackend();
    updateUpstreamBackendRoutePolicy(paths, "team-vps", {
      teamWorkspaceRead: "enabled"
    });
    const fallback = enrollmentFetch();
    const started = await startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:02:00.000Z"),
      randomId: () => "enroll-public-explorer",
      fetch: async (input, init) => {
        const url =
          typeof input === "string" || input instanceof URL ? input : input.url;
        if (
          init?.method === "POST" &&
          new URL(String(url)).pathname ===
            "/v1/local-edge/device-enrollments/challenges"
        ) {
          return response(true, 200, {
            challenge: { id: "challenge-public-explorer", status: "pending" },
            activationUrl:
              "https://app.example.test/device-enrollment/challenge-public-explorer"
          });
        }
        return fallback(input, init);
      }
    });

    expect(started.enrollment?.activationUrl).toBe(
      "https://app.example.test/device-enrollment/challenge-public-explorer"
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
        credential: { status: "configured", reference },
        principalUserId: remotePrincipalUserId,
        deviceCredentialId: remoteDeviceCredentialId
      }
    });
    expect(readUpstreamEnrollmentBinding(paths, "team-vps")).toEqual({
      backendId: "team-vps",
      enrollmentId: "enroll-exchange",
      principalUserId: remotePrincipalUserId,
      deviceCredentialId: remoteDeviceCredentialId
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

  it("authenticates replacement enrollment as an exact predecessor rotation", async () => {
    const paths = await registerValidatedBackend();
    updateUpstreamBackendRoutePolicy(paths, "team-vps", {
      teamWorkspaceRead: "enabled"
    });
    const original = await startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      randomId: () => "original-enrollment",
      fetch: enrollmentFetch()
    });
    const predecessorReference = original.enrollment!.credential.reference!;
    const predecessorAuthorization = readUpstreamCredentialAuthorization(
      paths.koedHome,
      predecessorReference
    );
    updateRegistry(paths, (registry) => {
      registry.backends[0]!.credential = {
        status: "configured",
        reference: predecessorReference
      };
    });
    await getUpstreamEnrollmentStatus(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:01:00.000Z"),
      fetch: enrollmentFetch("pending", true)
    });
    updateRegistry(paths, (registry) => {
      registry.backends[0]!.credential = { status: "not_configured" };
    });

    let rotationRequest:
      | { authorization: string | null; credentialId: string | null }
      | undefined;
    const replacement = await startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:02:00.000Z"),
      randomId: () => "replacement-enrollment",
      fetch: async (input, init) => {
        const url =
          typeof input === "string" || input instanceof URL ? input : input.url;
        if (
          init?.method === "POST" &&
          new URL(String(url)).pathname ===
            "/v1/local-edge/device-enrollments/challenges"
        ) {
          const body = JSON.parse(String(init.body ?? "{}")) as {
            rotate_credential_id?: unknown;
          };
          const headers = new Headers(init.headers);
          rotationRequest = {
            authorization: headers.get("authorization"),
            credentialId:
              typeof body.rotate_credential_id === "string"
                ? body.rotate_credential_id
                : null
          };
        }
        return enrollmentFetch("pending", true)(input, init);
      }
    });

    expect(replacement).toMatchObject({
      ok: true,
      state: "pending",
      enrollment: { requestId: "replacement-enrollment" }
    });
    expect(rotationRequest).toEqual({
      authorization: predecessorAuthorization,
      credentialId: remoteDeviceCredentialId
    });

    const pendingStore = JSON.parse(
      readFileSync(paths.upstreamEnrollmentsPath, "utf8")
    ) as {
      enrollments: Array<{
        activeCredentialReference?: string;
        pendingCredentialReference?: string;
        transactionState: {
          id: string;
          generation: number;
          kind: string;
          phase: string;
        };
      }>;
    };
    expect(pendingStore.enrollments.at(-1)).toMatchObject({
      activeCredentialReference: predecessorReference,
      transactionState: {
        id: "replacement-enrollment",
        generation: 2,
        kind: "replacement",
        phase: "awaiting_remote"
      }
    });
    expect(pendingStore.enrollments.at(-1)?.pendingCredentialReference).toMatch(
      /^keychain:\/\/koed-upstream\/team-vps\//
    );

    const commitEffects: string[] = [];
    await getUpstreamEnrollmentStatus(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:03:00.000Z"),
      fetch: enrollmentFetch("approved", true),
      beforeEnrollmentEffect: (boundary) => commitEffects.push(boundary)
    });
    expect(commitEffects).toEqual([
      "commit_local_client_credential",
      "commit_registry_credential",
      "commit_delete_predecessor_credential",
      "commit_enrollment_state"
    ]);
    expect(
      readUpstreamCredentialAuthorization(paths.koedHome, predecessorReference)
    ).toBeNull();
    const committedStore = JSON.parse(
      readFileSync(paths.upstreamEnrollmentsPath, "utf8")
    ) as {
      enrollments: Array<{
        activeCredentialReference?: string;
        pendingCredentialReference?: string;
        transactionState: { phase: string; kind: string };
      }>;
    };
    expect(committedStore.enrollments.at(-1)).toMatchObject({
      transactionState: { phase: "committed", kind: "replacement" }
    });
    expect(
      committedStore.enrollments.at(-1)?.activeCredentialReference
    ).toMatch(/^keychain:\/\/koed-upstream\/team-vps\//);
    expect(committedStore.enrollments.at(-1)).not.toHaveProperty(
      "pendingCredentialReference"
    );
  });

  it("recovers a replacement interrupted after successor commit without deleting it", async () => {
    const paths = await registerValidatedBackend();
    updateUpstreamBackendRoutePolicy(paths, "team-vps", {
      teamWorkspaceRead: "enabled"
    });
    const original = await startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      randomId: () => "recovery-original",
      fetch: enrollmentFetch()
    });
    const predecessorReference = original.enrollment!.credential.reference!;
    updateRegistry(paths, (registry) => {
      registry.backends[0]!.credential = {
        status: "configured",
        reference: predecessorReference
      };
    });
    await getUpstreamEnrollmentStatus(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:01:00.000Z"),
      fetch: enrollmentFetch("pending", true)
    });
    updateUpstreamBackendRoutePolicy(paths, "team-vps", {
      teamWorkspaceRead: "enabled",
      admin: "enabled"
    });
    await startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:02:00.000Z"),
      randomId: () => "recovery-replacement",
      fetch: enrollmentFetch("pending", true)
    });
    const pendingStore = JSON.parse(
      readFileSync(paths.upstreamEnrollmentsPath, "utf8")
    ) as {
      enrollments: Array<{ pendingCredentialReference?: string }>;
    };
    const successorReference =
      pendingStore.enrollments.at(-1)!.pendingCredentialReference!;
    let injected = false;

    const interrupted = await getUpstreamEnrollmentStatus(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:03:00.000Z"),
      fetch: enrollmentFetch("approved", true),
      beforeEnrollmentEffect: (boundary) => {
        if (!injected && boundary === "commit_delete_predecessor_credential") {
          injected = true;
          throw new Error("interrupted predecessor cleanup");
        }
      }
    });
    expect(interrupted).toMatchObject({ ok: false, state: "pending" });
    expect(
      readUpstreamCredentialAuthorization(paths.koedHome, successorReference)
    ).not.toBeNull();
    expect(
      readUpstreamCredentialAuthorization(paths.koedHome, predecessorReference)
    ).not.toBeNull();

    const recovered = await getUpstreamEnrollmentStatus(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:04:00.000Z"),
      fetch: enrollmentFetch("approved", true)
    });
    expect(recovered).toMatchObject({ ok: true, state: "exchanged" });
    expect(
      readUpstreamCredentialAuthorization(paths.koedHome, successorReference)
    ).not.toBeNull();
    expect(
      readUpstreamCredentialAuthorization(paths.koedHome, predecessorReference)
    ).toBeNull();
    expect(readUpstreamEnrollmentBinding(paths, "team-vps")).toMatchObject({
      enrollmentId: "recovery-replacement"
    });

    await expect(
      getUpstreamEnrollmentStatus(paths, "team-vps", {
        now: () => new Date("2026-01-01T00:05:00.000Z"),
        fetch: enrollmentFetch("approved", true)
      })
    ).resolves.toMatchObject({ state: "exchanged" });
  });

  it("does not cancel an active successor while its local commit requires recovery", async () => {
    const paths = await registerValidatedBackend();
    updateUpstreamBackendRoutePolicy(paths, "team-vps", {
      teamWorkspaceRead: "enabled"
    });
    const original = await startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      randomId: () => "cancel-recovery-original",
      fetch: enrollmentFetch()
    });
    const predecessorReference = original.enrollment!.credential.reference!;
    updateRegistry(paths, (registry) => {
      registry.backends[0]!.credential = {
        status: "configured",
        reference: predecessorReference
      };
    });
    await getUpstreamEnrollmentStatus(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:01:00.000Z"),
      fetch: enrollmentFetch("pending", true)
    });
    updateUpstreamBackendRoutePolicy(paths, "team-vps", {
      teamWorkspaceRead: "enabled",
      admin: "enabled"
    });
    await startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:02:00.000Z"),
      randomId: () => "cancel-recovery-replacement",
      fetch: enrollmentFetch("pending", true)
    });
    const pendingStore = JSON.parse(
      readFileSync(paths.upstreamEnrollmentsPath, "utf8")
    ) as {
      enrollments: Array<{ pendingCredentialReference?: string }>;
    };
    const successorReference =
      pendingStore.enrollments.at(-1)!.pendingCredentialReference!;
    let injected = false;
    const interrupted = await getUpstreamEnrollmentStatus(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:03:00.000Z"),
      fetch: enrollmentFetch("approved", true),
      beforeEnrollmentEffect: (boundary) => {
        if (!injected && boundary === "commit_registry_credential") {
          injected = true;
          throw new Error("interrupted registry commit");
        }
      }
    });
    expect(interrupted).toMatchObject({ ok: false, state: "pending" });

    const canceled = await cancelUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:04:00.000Z")
    });
    expect(canceled).toMatchObject({
      ok: false,
      state: "pending"
    });
    expect(canceled.message).toContain("must recover");
    expect(
      readUpstreamCredentialAuthorization(paths.koedHome, successorReference)
    ).not.toBeNull();
    expect(
      readUpstreamCredentialAuthorization(paths.koedHome, predecessorReference)
    ).not.toBeNull();

    const recovered = await getUpstreamEnrollmentStatus(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:05:00.000Z"),
      fetch: enrollmentFetch("approved", true)
    });
    expect(recovered).toMatchObject({ ok: true, state: "exchanged" });
    expect(
      readUpstreamCredentialAuthorization(paths.koedHome, successorReference)
    ).not.toBeNull();
    expect(
      readUpstreamCredentialAuthorization(paths.koedHome, predecessorReference)
    ).toBeNull();
  });

  it("rotates an exchanged credential when the browser-enrollable policy expands", async () => {
    const paths = await registerValidatedBackend();
    updateUpstreamBackendRoutePolicy(paths, "team-vps", {
      teamWorkspaceRead: "enabled"
    });
    const original = await startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      randomId: () => "original-policy-enrollment",
      fetch: enrollmentFetch()
    });
    const predecessorReference = original.enrollment!.credential.reference!;
    const predecessorAuthorization = readUpstreamCredentialAuthorization(
      paths.koedHome,
      predecessorReference
    );
    updateRegistry(paths, (registry) => {
      registry.backends[0]!.credential = {
        status: "configured",
        reference: predecessorReference
      };
    });
    await getUpstreamEnrollmentStatus(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:01:00.000Z"),
      fetch: enrollmentFetch("pending", true)
    });
    updateUpstreamBackendRoutePolicy(paths, "team-vps", {
      teamWorkspaceRead: "enabled",
      admin: "enabled"
    });

    let rotationRequest:
      | {
          authorization: string | null;
          credentialId: string | null;
          operationFamilies: unknown;
        }
      | undefined;
    const expanded = await startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:02:00.000Z"),
      randomId: () => "expanded-policy-enrollment",
      fetch: async (input, init) => {
        const url =
          typeof input === "string" || input instanceof URL ? input : input.url;
        if (
          init?.method === "POST" &&
          new URL(String(url)).pathname ===
            "/v1/local-edge/device-enrollments/challenges"
        ) {
          const body = JSON.parse(String(init.body ?? "{}")) as {
            rotate_credential_id?: unknown;
            requested_operation_families?: unknown;
          };
          const headers = new Headers(init.headers);
          rotationRequest = {
            authorization: headers.get("authorization"),
            credentialId:
              typeof body.rotate_credential_id === "string"
                ? body.rotate_credential_id
                : null,
            operationFamilies: body.requested_operation_families
          };
        }
        return enrollmentFetch("pending", true)(input, init);
      }
    });

    expect(expanded).toMatchObject({
      ok: true,
      state: "pending",
      enrollment: {
        requestId: "expanded-policy-enrollment",
        requestedOperationFamilies: [
          "team_workspace_read",
          "team_chat_read",
          "team_chat_write",
          "action_grant"
        ]
      }
    });
    expect(rotationRequest).toEqual({
      authorization: predecessorAuthorization,
      credentialId: remoteDeviceCredentialId,
      operationFamilies: [
        "team_workspace_read",
        "team_chat_read",
        "team_chat_write",
        "action_grant"
      ]
    });
  });

  it.each(["denied", "expired"] as const)(
    "keeps the active predecessor when replacement enrollment is %s",
    async (terminalState) => {
      const paths = await registerValidatedBackend();
      updateUpstreamBackendRoutePolicy(paths, "team-vps", {
        teamWorkspaceRead: "enabled"
      });
      const original = await startUpstreamEnrollment(paths, "team-vps", {
        now: () => new Date("2026-01-01T00:00:00.000Z"),
        randomId: () => `original-${terminalState}`,
        fetch: enrollmentFetch()
      });
      const predecessorReference = original.enrollment!.credential.reference!;
      updateRegistry(paths, (registry) => {
        registry.backends[0]!.credential = {
          status: "configured",
          reference: predecessorReference
        };
      });
      await getUpstreamEnrollmentStatus(paths, "team-vps", {
        now: () => new Date("2026-01-01T00:01:00.000Z"),
        fetch: enrollmentFetch("pending", true)
      });
      const predecessorLocal = readLocalEdgeClientCredentialAuthorization(
        paths.koedHome,
        "team-vps"
      );
      updateRegistry(paths, (registry) => {
        registry.backends[0]!.credential = { status: "not_configured" };
      });
      const replacement = await startUpstreamEnrollment(paths, "team-vps", {
        now: () => new Date("2026-01-01T00:02:00.000Z"),
        randomId: () => `replacement-${terminalState}`,
        fetch: enrollmentFetch("pending", true)
      });
      expect(replacement.state).toBe("pending");
      expect(replacement.backend?.credential).toEqual({
        status: "configured",
        reference: predecessorReference
      });
      const stored = JSON.parse(
        readFileSync(paths.upstreamEnrollmentsPath, "utf8")
      ) as { enrollments: Array<{ credentialReference: string }> };
      const replacementReference =
        stored.enrollments.at(-1)!.credentialReference;

      const result = await getUpstreamEnrollmentStatus(paths, "team-vps", {
        now: () => new Date("2026-01-01T00:03:00.000Z"),
        fetch: enrollmentFetch(terminalState, false)
      });

      expect(result).toMatchObject({
        state: terminalState,
        backend: {
          credential: { status: "configured", reference: predecessorReference }
        }
      });
      expect(
        readUpstreamCredentialAuthorization(
          paths.koedHome,
          predecessorReference
        )
      ).not.toBeNull();
      expect(
        readUpstreamCredentialAuthorization(
          paths.koedHome,
          replacementReference
        )
      ).toBeNull();
      expect(
        readLocalEdgeClientCredentialAuthorization(paths.koedHome, "team-vps")
      ).toEqual(predecessorLocal);
      const terminalStore = JSON.parse(
        readFileSync(paths.upstreamEnrollmentsPath, "utf8")
      ) as {
        enrollments: Array<{
          state: string;
          deviceCredentialId?: string;
          principalUserId?: string;
        }>;
      };
      expect(terminalStore.enrollments[0]).toMatchObject({
        state: "exchanged",
        deviceCredentialId: remoteDeviceCredentialId,
        principalUserId: remotePrincipalUserId
      });
      expect(readUpstreamEnrollmentBinding(paths, "team-vps")).toMatchObject({
        deviceCredentialId: remoteDeviceCredentialId,
        principalUserId: remotePrincipalUserId
      });
    }
  );

  it("keeps the active predecessor when replacement enrollment is canceled", async () => {
    const paths = await registerValidatedBackend();
    updateUpstreamBackendRoutePolicy(paths, "team-vps", {
      teamWorkspaceRead: "enabled"
    });
    const original = await startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      randomId: () => "original-canceled-rotation",
      fetch: enrollmentFetch()
    });
    const predecessorReference = original.enrollment!.credential.reference!;
    updateRegistry(paths, (registry) => {
      registry.backends[0]!.credential = {
        status: "configured",
        reference: predecessorReference
      };
    });
    await getUpstreamEnrollmentStatus(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:01:00.000Z"),
      fetch: enrollmentFetch("pending", true)
    });
    const predecessorLocal = readLocalEdgeClientCredentialAuthorization(
      paths.koedHome,
      "team-vps"
    );
    updateRegistry(paths, (registry) => {
      registry.backends[0]!.credential = { status: "not_configured" };
    });
    const replacement = await startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:02:00.000Z"),
      randomId: () => "replacement-canceled-rotation",
      fetch: enrollmentFetch("pending", true)
    });
    expect(replacement.state).toBe("pending");
    expect(replacement.backend?.credential).toEqual({
      status: "configured",
      reference: predecessorReference
    });

    const result = await cancelUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:03:00.000Z")
    });

    expect(result).toMatchObject({
      state: "canceled",
      backend: {
        credential: { status: "configured", reference: predecessorReference }
      }
    });
    expect(
      readUpstreamCredentialAuthorization(paths.koedHome, predecessorReference)
    ).not.toBeNull();
    expect(
      readLocalEdgeClientCredentialAuthorization(paths.koedHome, "team-vps")
    ).toEqual(predecessorLocal);
    expect(readUpstreamEnrollmentBinding(paths, "team-vps")).not.toBeNull();
  });

  it("fails closed when a stored predecessor cannot be verified for rotation", async () => {
    const paths = await registerValidatedBackend();
    updateUpstreamBackendRoutePolicy(paths, "team-vps", {
      teamWorkspaceRead: "enabled"
    });
    const original = await startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      randomId: () => "unavailable-predecessor",
      fetch: enrollmentFetch()
    });
    const predecessorReference = original.enrollment!.credential.reference!;
    updateRegistry(paths, (registry) => {
      registry.backends[0]!.credential = {
        status: "configured",
        reference: predecessorReference
      };
    });
    await getUpstreamEnrollmentStatus(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:00:30.000Z"),
      fetch: enrollmentFetch("pending", true)
    });
    updateRegistry(paths, (registry) => {
      registry.backends[0]!.credential = { status: "not_configured" };
    });
    const challengeRequest = vi.fn();
    const restarted = await startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:01:00.000Z"),
      fetch: async (input, init) => {
        const url =
          typeof input === "string" || input instanceof URL ? input : input.url;
        const pathname = new URL(String(url)).pathname;
        if (pathname === "/v1/local-edge/device-credentials/status") {
          return response(false, 503, { error: "temporarily unavailable" });
        }
        if (
          init?.method === "POST" &&
          pathname === "/v1/local-edge/device-enrollments/challenges"
        ) {
          challengeRequest();
        }
        return enrollmentFetch()(input, init);
      }
    });

    expect(original.ok).toBe(true);
    expect(restarted).toMatchObject({
      ok: false,
      state: "failed",
      message:
        "Could not verify the existing upstream device credential required for authenticated rotation. Retry when the Team Backend is available."
    });
    expect(challengeRequest).not.toHaveBeenCalled();
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

  it("maps admin routing to narrow browser-confirmed action-grant authority", async () => {
    const paths = await registerValidatedBackend();
    updateUpstreamBackendRoutePolicy(paths, "team-vps", {
      admin: "enabled"
    });

    const started = await startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      randomId: () => "enroll-action-grant-only",
      fetch: enrollmentFetch()
    });

    expect(started).toMatchObject({
      ok: true,
      state: "pending",
      enrollment: {
        requestedOperationFamilies: ["action_grant"]
      }
    });
  });

  it("never requests reusable admin authority during mixed browser enrollment", async () => {
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
        requestedOperationFamilies: [
          "team_workspace_read",
          "team_chat_read",
          "team_chat_write",
          "action_grant"
        ]
      }
    });
    expect(started.enrollment?.requestedOperationFamilies).not.toContain(
      "admin"
    );
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
        now: () => new Date("2026-01-01T00:03:00.000Z"),
        fetch: enrollmentFetch()
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

    completeUpstreamDisconnectCleanup(paths, "team-vps");
    updateUpstreamBackendRoutePolicy(paths, "team-vps", {
      teamWorkspaceRead: "enabled"
    });
    await validateBackendCapabilities(paths);
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

  it("revokes an exchanged upstream credential before clearing local state", async () => {
    const paths = await registerValidatedBackend();
    updateUpstreamBackendRoutePolicy(paths, "team-vps", {
      teamWorkspaceRead: "enabled"
    });
    const started = await startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      randomId: () => "enroll-remote-revoke",
      fetch: enrollmentFetch()
    });
    const reference = started.enrollment!.credential.reference!;
    await getUpstreamEnrollmentStatus(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:01:00.000Z"),
      fetch: enrollmentFetch("approved", true)
    });
    let remoteAuthorization: string | null = null;
    const disconnected = await disconnectUpstreamBackendEnrollment(
      paths,
      "team-vps",
      {
        now: () => new Date("2026-01-01T00:02:00.000Z"),
        fetch: async (input, init) => {
          const url =
            typeof input === "string" || input instanceof URL
              ? input
              : input.url;
          expect(init?.method).toBe("DELETE");
          expect(new URL(String(url)).pathname).toBe(
            "/v1/local-edge/device-credentials/current"
          );
          remoteAuthorization = new Headers(init?.headers).get("authorization");
          return response(true, 200, { revoked: true });
        }
      }
    );

    expect(remoteAuthorization).toMatch(/^Koed-Device /);
    expect(disconnected).toMatchObject({ ok: true, state: "revoked" });
    expect(
      readUpstreamCredentialAuthorization(paths.koedHome, reference)
    ).toBeNull();
  });

  it("keeps local enrollment usable for retry when remote revocation is unavailable", async () => {
    const paths = await registerValidatedBackend();
    updateUpstreamBackendRoutePolicy(paths, "team-vps", {
      teamWorkspaceRead: "enabled"
    });
    const started = await startUpstreamEnrollment(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      randomId: () => "enroll-revoke-retry",
      fetch: enrollmentFetch()
    });
    const reference = started.enrollment!.credential.reference!;
    await getUpstreamEnrollmentStatus(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:01:00.000Z"),
      fetch: enrollmentFetch("approved", true)
    });

    const disconnected = await disconnectUpstreamBackendEnrollment(
      paths,
      "team-vps",
      {
        now: () => new Date("2026-01-01T00:02:00.000Z"),
        fetch: enrollmentFetch("approved", "unknown")
      }
    );

    expect(disconnected).toMatchObject({
      ok: false,
      state: "failed",
      backend: {
        routePolicy: { teamWorkspaceRead: "enabled" },
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
      now: () => new Date("2026-01-01T00:02:00.000Z"),
      fetch: enrollmentFetch()
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
      now: () => new Date("2026-01-01T00:02:00.000Z"),
      fetch: enrollmentFetch()
    });
    completeUpstreamDisconnectCleanup(paths, "team-vps");
    updateUpstreamBackendRoutePolicy(paths, "team-vps", {
      teamWorkspaceRead: "enabled"
    });
    await validateBackendCapabilities(paths);
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

  it("does not let a late challenge response revive a durably prepared enrollment after disconnect", async () => {
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
      randomId: () => "disconnect-record",
      fetch: enrollmentFetch()
    });
    pendingChallenge.release();

    await expect(startPromise).resolves.toMatchObject({
      ok: true,
      state: "revoked",
      enrollment: { requestId: "enrollment-starting", state: "revoked" }
    });
    expect(
      readLocalEdgeClientCredentialAuthorization(paths.koedHome, "team-vps")
    ).toBeNull();
  });
});
