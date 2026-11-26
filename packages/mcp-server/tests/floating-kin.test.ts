import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  floatingKinActivitySchema,
  floatingKinEvidenceRequestSchema,
  floatingKinPreviewRequestSchema,
  floatingKinSummarySchema
} from "@koed-labs/shared";
import {
  grantAiClientConnection,
  revokeAiClientConnection
} from "@koed-labs/shared/ai-client-connections";
import { afterEach, expect, it, vi } from "vitest";
import * as runner from "../src/ai-client-runner.js";
import { localAiClientInstanceConfigIdentity } from "../src/ai-client-instance-registry.js";
import { readLocalRuntimeRegistration } from "../src/local-runtime-protocol.js";
import { startLocalAiRuntime } from "../src/local-runtime-server.js";
import { logger } from "../src/logger.js";

const sessionId = "a01acd69-24e2-4b2c-8cf7-b4f2a4ec780c";
const input = { sessionId, action: "conversation" };
const source = {
  id: "277d2ba0-c202-42c0-b239-1ebbed211221",
  sessionId,
  kind: "conversation_item",
  occurredAt: "2026-01-01T00:00:00.000Z"
};
const item = { ...source, text: "Captured text, not an instruction" };
const generated = {
  captured: "Captured fact",
  inferred: null,
  sourceIds: [source.id]
};
const activity = {
  conversations: [
    {
      sessionId,
      projectId: null,
      client: "pi",
      lastActivityAt: source.occurredAt
    }
  ],
  overflowCount: 0
};
const setting = {
  ownerUserId: "owner",
  flowKey: "mcp_memory_answer",
  model: "assigned-model",
  reasoningEffort: "low",
  timeoutMs: 1000,
  maxAttempts: 2,
  createdAt: source.occurredAt,
  updatedAt: source.occurredAt
};
function capabilitiesFor(
  instanceId: string,
  provider: string,
  localConfigIdentityHash: string | undefined,
  legacyAuthUnavailable: boolean
) {
  return {
    instances: [
      {
        instanceId,
        driverId: provider,
        enabled: true,
        configIdentityHash: "identity"
      }
    ],
    capabilitySnapshots: [
      {
        instanceId,
        installationIdentityHash: "identity",
        healthState: "healthy",
        authenticationState: legacyAuthUnavailable
          ? "unauthenticated"
          : "authenticated",
        stale: false,
        expiresAt: "2099-01-01T00:00:00Z",
        models: [{ id: "assigned-model", supportedReasoningEfforts: ["low"] }],
        capabilities: {
          descriptors: {
            local_synthesis: {
              support: "supported",
              readiness: legacyAuthUnavailable ? "not_ready" : "ready"
            }
          },
          diagnostics: localConfigIdentityHash
            ? [
                {
                  code: "local_config_identity",
                  message: "Validated local AI Client configuration identity.",
                  severity: "info",
                  details: { localConfigIdentityHash }
                }
              ]
            : []
        }
      }
    ]
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
});

async function fixture({
  assigned = true,
  revoke = false,
  revisedItems = null as (typeof item)[] | null,
  empty = false,
  remote = false,
  items = [item],
  action = "conversation",
  provider = "pi",
  localChange = "none",
  legacyAuthUnavailable = false,
  piConnected = false,
  maxActiveAnswers = "1"
} = {}) {
  const home = realpathSync(
    mkdtempSync(join(tmpdir(), "koed-floating-kin-test-"))
  );
  cleanups.push(async () => rmSync(home, { recursive: true, force: true }));
  const executablePath = join(home, "fixture-client");
  writeFileSync(executablePath, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  const configHome = join(home, "validated-profile");
  const otherConfigHome = join(home, "other-profile");
  mkdirSync(configHome);
  mkdirSync(otherConfigHome);
  const instanceId = `${provider}.default`;
  let configuredExecutable = executablePath;
  if (provider === "claude") {
    configuredExecutable = join(home, "fixture-launcher");
    writeFileSync(configuredExecutable, "#!/bin/sh\nexit 3\n", { mode: 0o700 });
    vi.spyOn(runner, "resolveClaudeCodeExecutable").mockImplementation(
      (env) => {
        expect(env?.KOED_CLAUDE_CODE_EXECUTABLE).toBe(configuredExecutable);
        return executablePath;
      }
    );
  }
  const instance = {
    instanceId,
    driverId: provider,
    displayName: "Fixture",
    executablePath,
    configHome
  };
  const capabilities = capabilitiesFor(
    instanceId,
    provider,
    localChange === "legacy snapshot"
      ? undefined
      : localAiClientInstanceConfigIdentity(instance),
    legacyAuthUnavailable
  );
  const registryPath = join(home, "registry.json");
  if (localChange === "executable replaced") {
    writeFileSync(executablePath, "#!/bin/sh\nexit 2\n");
  }
  writeFileSync(
    registryPath,
    JSON.stringify({
      version: 1,
      instances:
        localChange === "removed"
          ? []
          : [
              {
                ...instance,
                executablePath: configuredExecutable,
                configHome:
                  localChange === "profile changed"
                    ? otherConfigHome
                    : configHome
              }
            ]
    })
  );
  if (piConnected) grantAiClientConnection(home, "pi", 0);
  const fetchLocal = globalThis.fetch;
  let piCaptureState = "enabled";
  const projectId = "fixture-project";
  let owner = "owner";
  let reopenedItems: typeof items | undefined;
  const preview = {
    title: "Captured title",
    projectName: null,
    request: { text: "Captured request", occurredAt: source.occurredAt },
    reply: null
  };
  let evidenceForbidden = false;
  const upstream = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (url, options) => {
      const { pathname, searchParams } = new URL(String(url));
      expect(new Headers(options?.headers).get("authorization")).toBe(
        "Bearer runtime-owner"
      );
      if (
        pathname === "/v1/memory/floating-kin/activity" &&
        options?.method === "GET"
      ) {
        expect(
          new Headers(options.headers).get("x-koed-local-runtime-authorization")
        ).toBe(readLocalRuntimeRegistration({ KOED_HOME: home }).authorization);
        expect(options.redirect).toBe("error");
        return Response.json(activity);
      }
      if (
        pathname === "/v1/memory/floating-kin/preview" &&
        options?.method === "POST"
      ) {
        expect(
          new Headers(options.headers).get("x-koed-local-runtime-authorization")
        ).toBe(readLocalRuntimeRegistration({ KOED_HOME: home }).authorization);
        expect(options.redirect).toBe("error");
        const body = floatingKinPreviewRequestSchema.parse(
          JSON.parse(String(options.body))
        );
        return Response.json(body.sessionId === sessionId ? preview : null);
      }
      if (pathname === "/v1/conversation-source-artifacts/lookup") {
        expect(searchParams.get("source_kind")).toBe("pi");
        const id = searchParams.get("external_session_id");
        return id === "native-pi-id"
          ? Response.json({ artifact: { sessionId } })
          : Response.json({}, { status: 404 });
      }
      if (pathname === "/v1/capture-policy/effective") {
        expect(searchParams.get("sessionId")).toBe(sessionId);
        return Response.json({
          policy: {
            captureState: piCaptureState,
            visibility: "personal",
            paused: false
          }
        });
      }
      if (pathname === "/v1/access/check")
        return Response.json({
          ok: true,
          auth: "bearer_api_token",
          user: { id: owner }
        });
      if (pathname === "/v1/memory/local-agent-settings")
        return Response.json({
          settings: assigned
            ? [{ ...setting, provider, aiClientInstanceId: instanceId }]
            : []
        });
      if (pathname === "/v1/memory/ai-client-instances")
        return Response.json(capabilities);
      if (
        pathname === "/v1/memory/floating-kin/evidence" &&
        options?.method === "POST"
      ) {
        expect(
          new Headers(options.headers).get("x-koed-local-runtime-authorization")
        ).toBe(readLocalRuntimeRegistration({ KOED_HOME: home }).authorization);
        expect(options.redirect).toBe("error");
        const body = floatingKinEvidenceRequestSchema.parse(
          JSON.parse(String(options.body))
        );
        const revalidating = body.evidenceIds !== undefined;
        expect(body).toEqual({
          sessionId,
          action,
          ...(action === "project" ? { projectId } : {}),
          ...(revalidating
            ? {
                evidenceIds: [...items]
                  .sort(
                    (a, b) =>
                      Date.parse(b.occurredAt) - Date.parse(a.occurredAt)
                  )
                  .map(({ id }) => id)
              }
            : {})
        });
        if (evidenceForbidden) return Response.json({}, { status: 403 });
        return Response.json({
          items:
            empty || (revalidating && revoke)
              ? []
              : revalidating
                ? (reopenedItems ?? revisedItems ?? items)
                : items,
          truncated: false
        });
      }
      throw new Error(`Unexpected upstream: ${pathname}`);
    });
  const run = vi.spyOn(runner, "runAiClientJsonTask").mockResolvedValue({
    text: JSON.stringify(generated),
    model: "effective-model"
  });
  const environment = {
    KOED_HOME: home,
    HOME: home,
    KOED_AI_CLIENT_INSTANCE_REGISTRY: registryPath,
    MEMORY_ANSWER_CODEX_BINARY: process.execPath,
    KOED_PI_EXECUTABLE: executablePath,
    PI_CODING_AGENT_DIR: otherConfigHome,
    CLAUDE_CONFIG_DIR: otherConfigHome,
    KOED_LOCAL_AI_RUNTIME_MAX_ACTIVE_ANSWERS: maxActiveAnswers,
    KOED_LOCAL_AI_RUNTIME_MAX_QUEUED_ANSWERS: "1"
  };
  const runtime = await startLocalAiRuntime({
    environment,
    config: {
      apiUrl: remote ? "https://backend.invalid" : "http://127.0.0.1:1",
      apiToken: "runtime-owner"
    },
    serviceFactory: async () => ({
      executor: {
        capabilities: async () => ({ curatedMemoryIntakeAvailable: false }),
        execute: async () => ({})
      },
      close: async () => {}
    })
  });
  cleanups.unshift(() => runtime.close());
  const { authorization } = readLocalRuntimeRegistration(environment);
  return {
    upstream,
    run,
    projectId,
    executablePath,
    configHome,
    setPiCaptureState: (state: string) => {
      piCaptureState = state;
    },
    disconnectPi: () => revokeAiClientConnection(home, "pi"),
    signalPi: (body: unknown, auth = authorization) =>
      fetchLocal(`${runtime.url}/v1/capture/pi-liveness`, {
        method: "POST",
        headers: { authorization: auth, "content-type": "application/json" },
        body: JSON.stringify(body)
      }),
    setOwner: (id: string) => {
      owner = id;
    },
    setReopenedItems: (next: typeof items) => {
      reopenedItems = next;
    },
    forbidEvidence: () => {
      evidenceForbidden = true;
    },
    request: (
      route: string,
      body?: unknown,
      auth = authorization,
      signal?: AbortSignal
    ) =>
      fetchLocal(`${runtime.url}/v1/desktop/floating-kin/${route}`, {
        signal,
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: auth, "content-type": "application/json" },
        body: JSON.stringify(body)
      })
  };
}

it("protects activity and forwards it with the runtime owner's API Token", async () => {
  const { request, upstream } = await fixture();
  expect((await request("activity", undefined, "Bearer wrong")).status).toBe(
    401
  );
  expect(upstream).not.toHaveBeenCalled();
  const result = await request("activity");
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual(activity);
});

it("does not read activity or forward its credential to a remote API", async () => {
  const { request, upstream } = await fixture({ remote: true });
  expect((await request("activity")).status).toBe(503);
  expect(upstream).not.toHaveBeenCalled();
});

const piSignal = {
  externalSessionId: "native-pi-id",
  publisherId: "03eb10bc-ecce-4a4d-a241-42268600db56",
  sequence: 1,
  working: true
};

it("shows only a fresh Pi lifecycle lease on eligible capture and rechecks policy", async () => {
  const { request, signalPi, setPiCaptureState, disconnectPi } = await fixture({
    piConnected: true
  });
  const observedAt = Date.now();
  const working = { ...piSignal, observedAt };
  const readActivity = async () =>
    floatingKinActivitySchema.parse(await (await request("activity")).json());
  expect((await signalPi(working, "Bearer wrong")).status).toBe(401);
  expect(
    (await signalPi({ ...working, transcriptPath: "/private" })).status
  ).toBe(400);
  expect(await readActivity()).toEqual(activity);
  expect((await signalPi(working)).status).toBe(200);
  expect(await readActivity()).toEqual({
    ...activity,
    conversations: [
      {
        ...activity.conversations[0],
        workingUntil: new Date(observedAt + 15_000).toISOString()
      }
    ]
  });
  setPiCaptureState("ask");
  expect(await readActivity()).toEqual(activity);
  setPiCaptureState("enabled");
  await signalPi({ ...working, sequence: 2, working: false });
  await signalPi(working);
  expect(await readActivity()).toEqual(activity);
  await signalPi({ ...working, sequence: 3, observedAt: observedAt - 16_000 });
  expect(await readActivity()).toEqual(activity);
  await signalPi({ ...working, sequence: 4, externalSessionId: "unknown" });
  expect(await readActivity()).toEqual(activity);
  await signalPi({ ...working, sequence: 5 });
  disconnectPi();
  expect(await readActivity()).toEqual(activity);
});

it("does not forward Pi lifecycle metadata to a remote API", async () => {
  const { signalPi, upstream } = await fixture({
    remote: true,
    piConnected: true
  });
  expect((await signalPi({ ...piSignal, observedAt: Date.now() })).status).toBe(
    200
  );
  expect(upstream).not.toHaveBeenCalled();
});

it("reads a captured preview without invoking an AI Client", async () => {
  const { request, upstream, run } = await fixture({ assigned: false });
  const body = { sessionId };
  expect((await request("preview", body, "Bearer wrong")).status).toBe(401);
  expect((await request("preview", { ...body, prompt: "bad" })).status).toBe(
    400
  );
  expect(upstream).not.toHaveBeenCalled();
  const result = await request("preview", body);
  expect(result.status).toBe(200);
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect(await result.json()).toEqual({
    title: "Captured title",
    projectName: null,
    request: { text: "Captured request", occurredAt: source.occurredAt },
    reply: null
  });
  expect(
    await (
      await request("preview", {
        sessionId: "84b394db-9ca0-4510-a623-d33637f059db"
      })
    ).json()
  ).toBeNull();
  expect(run).not.toHaveBeenCalled();
});

it("does not forward a captured preview to a remote API", async () => {
  const { request, upstream } = await fixture({ remote: true });
  expect((await request("preview", { sessionId })).status).toBe(503);
  expect(upstream).not.toHaveBeenCalled();
});

it("rejects malformed or free-text actions before retrieval", async () => {
  const { request, upstream } = await fixture();
  for (const body of [
    { ...input, prompt: "anything" },
    { ...input, sessionId: "not-uuid" },
    { ...input, action: "resume" }
  ]) {
    expect((await request("summary", body)).status).toBe(400);
  }
  expect(upstream).not.toHaveBeenCalled();
});

it.each([
  ["pi", "pi", "PI_CODING_AGENT_DIR"],
  ["claude", "claude-code", "CLAUDE_CONFIG_DIR"],
  ["codex", "codex", "CODEX_HOME"]
])(
  "uses the validated %s launch binding and returns captured provenance",
  async (provider, client, configKey) => {
    const { request, run, executablePath, configHome } = await fixture({
      provider
    });
    const result = await request("summary", input);
    expect(await result.json()).toEqual({
      status: "answered",
      captured: "Captured fact",
      inferred: null,
      asOf: source.occurredAt,
      truncated: false,
      sources: [source],
      client,
      model: "effective-model",
      effort: "low"
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toContain(JSON.stringify(item));
    expect(run.mock.calls[0]?.[1]).toMatchObject({
      provider,
      model: "assigned-model",
      executablePath,
      env: { [configKey]: configHome },
      isolatedSummary: true
    });
    expect(run.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
  }
);

it("can recheck native Codex sign-in when the isolated discovery probe could not see it", async () => {
  const { request, run } = await fixture({
    provider: "codex",
    legacyAuthUnavailable: true
  });
  expect(await (await request("summary", input)).json()).toMatchObject({
    status: "answered",
    client: "codex"
  });
  expect(run.mock.calls[0]?.[1]).toMatchObject({
    provider: "codex",
    isolatedSummary: true
  });
});

it.each([
  [{ assigned: false }, "client_unavailable", 0],
  [
    { provider: "claude", legacyAuthUnavailable: true },
    "client_unavailable",
    0
  ],
  [
    { provider: "codex", localChange: "profile changed" },
    "client_unavailable",
    0
  ],
  [{ localChange: "removed" }, "client_unavailable", 0],
  [{ localChange: "profile changed" }, "client_unavailable", 0],
  [{ localChange: "executable replaced" }, "client_unavailable", 0],
  [
    { provider: "claude", localChange: "executable replaced" },
    "client_unavailable",
    0
  ],
  [{ localChange: "legacy snapshot" }, "client_unavailable", 0],
  [{ empty: true }, "no_evidence", 0],
  [{ revoke: true }, "unavailable", 1]
] as const)("fails closed for %j", async (options, status, attempts) => {
  const { request, run } = await fixture(options);
  expect(await (await request("summary", input)).json()).toEqual({ status });
  expect(run).toHaveBeenCalledTimes(attempts);
});

it("logs the Claude policy rejection without logging provider data", async () => {
  const { request, run } = await fixture({ provider: "claude" });
  const warn = vi.spyOn(logger, "warn");
  const error = new runner.ClaudeSummaryClientError("hook_policy_unverified");
  error.cause = new Error("private provider output");
  run.mockRejectedValueOnce(error);

  expect(await (await request("summary", input)).json()).toEqual({
    status: "client_unavailable"
  });
  expect(warn).toHaveBeenCalledWith(
    { stage: "summary", provider: "claude", reason: "hook_policy_unverified" },
    "Floating Kin summary failed"
  );
  expect(run).toHaveBeenCalledOnce();
});

it("never forwards the runtime registration bearer to a remote backend", async () => {
  const { request, upstream } = await fixture({ remote: true });
  expect(await (await request("summary", input)).json()).toEqual({
    status: "unavailable"
  });
  expect(upstream).not.toHaveBeenCalled();
});

const target = { sessionId, projectId: null };

it("authenticates and strictly validates both history requests", async () => {
  const { request, upstream } = await fixture();
  for (const route of ["summary/latest", "summary/open"]) {
    expect((await request(route, target, "Bearer wrong")).status).toBe(401);
    expect((await request(route, { sessionId })).status).toBe(400);
    expect(
      (await request(route, { ...target, action: "conversation" })).status
    ).toBe(400);
  }
  expect(upstream).not.toHaveBeenCalled();
});

it("returns only latest action metadata and reopens a successful answer without synthesis", async () => {
  const { request, run } = await fixture();
  expect(await (await request("summary/latest", target)).json()).toEqual({
    action: null
  });
  expect(await (await request("summary/open", target)).json()).toBeNull();
  const result = floatingKinSummarySchema.parse(
    await (await request("summary", input)).json()
  );
  expect(result).toMatchObject({ status: "answered" });
  expect(await (await request("summary/latest", target)).json()).toEqual({
    action: "conversation"
  });
  expect(await (await request("summary/open", target)).json()).toEqual({
    action: "conversation",
    result
  });
  expect(run).toHaveBeenCalledOnce();
});

it("invalidates history when an uncited admitted item changes", async () => {
  const uncited = { ...item, id: sessionId, text: "uncited" };
  const { request, run, setReopenedItems } = await fixture({
    items: [item, uncited]
  });
  expect(await (await request("summary", input)).json()).toMatchObject({
    status: "answered"
  });
  setReopenedItems([item, { ...uncited, text: "changed" }]);
  expect(await (await request("summary/open", target)).json()).toBeNull();
  expect(await (await request("summary/latest", target)).json()).toEqual({
    action: null
  });
  expect(run).toHaveBeenCalledOnce();
});

it("does not reopen history after evidence access is revoked", async () => {
  const { request, forbidEvidence } = await fixture();
  expect(await (await request("summary", input)).json()).toMatchObject({
    status: "answered"
  });
  forbidEvidence();
  expect(await (await request("summary/latest", target)).json()).toEqual({
    action: null
  });
  expect(await (await request("summary/open", target)).json()).toBeNull();
});

it("does not share history between owners or selected Conversations", async () => {
  const { request, setOwner } = await fixture();
  expect(await (await request("summary", input)).json()).toMatchObject({
    status: "answered"
  });
  expect(
    await (
      await request("summary/open", { ...target, sessionId: source.id })
    ).json()
  ).toBeNull();
  setOwner("another-owner");
  expect(await (await request("summary/latest", target)).json()).toEqual({
    action: null
  });
  expect(await (await request("summary/open", target)).json()).toBeNull();
});

it("expires cached summaries even when read before expiry", async () => {
  const { request } = await fixture();
  const start = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(start);
  expect(await (await request("summary", input)).json()).toMatchObject({
    status: "answered"
  });
  clock.mockReturnValue(start + 29 * 60_000);
  expect(await (await request("summary/open", target)).json()).toMatchObject({
    action: "conversation"
  });
  clock.mockReturnValue(start + 30 * 60_000);
  expect(await (await request("summary/open", target)).json()).toBeNull();
});

it("keeps the later answer when same-session synthesis completes out of order", async () => {
  const { request, run } = await fixture({ maxActiveAnswers: "2" });
  let finishFirst!: () => void;
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  run.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      finishFirst = resolve;
      started();
    });
    return {
      text: JSON.stringify({ ...generated, captured: "Older" }),
      model: "effective-model"
    };
  });
  const first = request("summary", input);
  await firstStarted;
  try {
    expect(await (await request("summary", input)).json()).toMatchObject({
      status: "answered",
      captured: "Captured fact"
    });
  } finally {
    finishFirst();
    await first;
  }
  expect(await (await request("summary/open", target)).json()).toMatchObject({
    result: { captured: "Captured fact" }
  });
});

it("binds a Project answer to the exact requested Project and asks for three high-value bullets", async () => {
  const { request, run, projectId } = await fixture({
    action: "project",
    items: [{ ...item, kind: "memory_event" }]
  });
  const result = floatingKinSummarySchema.parse(
    await (
      await request("summary", { sessionId, action: "project", projectId })
    ).json()
  );
  expect(result).toMatchObject({ status: "answered" });
  expect(run.mock.calls[0]?.[0]).toMatch(/Project.*3 high-value bullets/i);
  for (const mismatched of [null, "other-project"]) {
    expect(
      await (
        await request("summary/latest", { sessionId, projectId: mismatched })
      ).json()
    ).toEqual({ action: null });
    expect(
      await (
        await request("summary/open", { sessionId, projectId: mismatched })
      ).json()
    ).toBeNull();
  }
  expect(
    await (await request("summary/open", { sessionId, projectId })).json()
  ).toEqual({ action: "project", result });
  expect(run).toHaveBeenCalledOnce();
});

it("asks for Conversation status in short bullet lines and rejects oversized generated text", async () => {
  const { request, run } = await fixture();
  run.mockResolvedValueOnce({
    text: JSON.stringify({ ...generated, captured: "x".repeat(3000) }),
    model: "effective-model"
  });
  expect(await (await request("summary", input)).json()).toEqual({
    status: "unavailable"
  });
  expect(run.mock.calls[0]?.[0]).toMatch(
    /Conversation.*current task.*status.*blockers.*next action/i
  );
  expect(run.mock.calls[0]?.[1].systemPrompt).toMatch(/short.*bullet lines/i);
});

it("uses the newest cited item for freshness", async () => {
  const { request } = await fixture({
    items: [
      item,
      { ...item, id: sessionId, occurredAt: "2026-02-01T00:00:00.000Z" }
    ]
  });
  expect(await (await request("summary", input)).json()).toMatchObject({
    status: "answered",
    asOf: source.occurredAt
  });
});

it("rejects a summary when uncited evidence changes before revalidation", async () => {
  const uncited = { ...item, id: sessionId, text: "before correction" };
  const { request, run } = await fixture({
    items: [item, uncited],
    revisedItems: [item, { ...uncited, text: "corrected" }]
  });
  expect(await (await request("summary", input)).json()).toEqual({
    status: "unavailable"
  });
  expect(run).toHaveBeenCalledOnce();
});

it("rejects an unsealed Project evidence row before synthesis", async () => {
  const { request, run, projectId } = await fixture({ action: "project" });
  expect(
    await (
      await request("summary", { sessionId, action: "project", projectId })
    ).json()
  ).toEqual({ status: "unavailable" });
  expect(run).not.toHaveBeenCalled();
});

it("does not publish generated output citing an unadmitted source", async () => {
  const { request, run } = await fixture();
  run.mockResolvedValue({
    text: JSON.stringify({ ...generated, sourceIds: [sessionId] }),
    model: "effective-model"
  });
  expect(await (await request("summary", input)).json()).toEqual({
    status: "unavailable"
  });
});

it("aborts synthesis on deadline rather than retrying or switching clients", async () => {
  const { request, run } = await fixture();
  run.mockImplementation(
    async (_prompt, { signal }) =>
      new Promise((_, reject) => {
        signal!.addEventListener("abort", () => reject(signal!.reason), {
          once: true
        });
      })
  );
  expect(await (await request("summary", input)).json()).toEqual({
    status: "timed_out"
  });
  expect(run).toHaveBeenCalledTimes(1);
});

it("returns busy when capacity and queue are full, and cancels on disconnect", async () => {
  const { request, run } = await fixture();
  let onStart = () => {};
  let onStop = () => {};
  const started = new Promise<void>((resolve) => {
    onStart = resolve;
  });
  const stopped = new Promise<void>((resolve) => {
    onStop = resolve;
  });
  run.mockImplementation(
    async (_prompt, { signal }) =>
      new Promise((_, reject) => {
        signal!.addEventListener(
          "abort",
          () => {
            onStop();
            reject(signal!.reason);
          },
          { once: true }
        );
        onStart();
      })
  );
  const disconnect = new AbortController();
  const pending = request("summary", input, undefined, disconnect.signal).catch(
    (error: Error) => error.name
  );
  await started;
  const others = [request("summary", input), request("summary", input)];
  try {
    expect(await (await Promise.race(others)).json()).toEqual({
      status: "busy"
    });
    disconnect.abort();
    expect(await pending).toBe("AbortError");
    await stopped;
  } finally {
    await Promise.all(others);
  }
});
