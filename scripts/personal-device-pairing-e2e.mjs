#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  decryptPersonalDevicePairingMessage,
  encryptPersonalDevicePairingMessage
} from "../apps/desktop/dist-electron/personal-device-pairing-crypto.js";
import { startPersonalDevicePairingServer } from "../apps/desktop/dist-electron/personal-device-pairing-server.js";
import { resolveKoedServerPaths } from "../packages/koed-server/dist/paths.js";
import { runPersonalSyncCommand } from "../packages/koed-server/dist/personal-sync.js";
import { reconcileJoiningDeviceDatabase } from "./personal-device-pairing-e2e-lib.mjs";

const controlUrl = process.env.PDS_E2E_CONTROL_URL?.trim();
const joiningControlUrl =
  process.env.PDS_E2E_JOINING_CONTROL_URL?.trim() ?? null;
let browserCookie = process.env.PDS_E2E_BROWSER_COOKIE?.trim();
const joiningBrowserCookie =
  process.env.PDS_E2E_JOINING_BROWSER_COOKIE?.trim() ?? null;
const desktopAuthorization = process.env.PDS_E2E_DESKTOP_AUTHORIZATION?.trim();
const joiningDesktopAuthorization =
  process.env.PDS_E2E_JOINING_DESKTOP_AUTHORIZATION?.trim() ?? null;
if (!controlUrl) {
  throw new Error("PDS_E2E_CONTROL_URL is required.");
}
const browserOrigin =
  process.env.PDS_E2E_BROWSER_ORIGIN?.trim() || "http://127.0.0.1:5174";
new URL(browserOrigin);
if (
  !desktopAuthorization &&
  !browserCookie &&
  process.env.PDS_E2E_ALLOW_REGISTER === "1"
) {
  const registration = await fetch(new URL("/auth/register", controlUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: browserOrigin
    },
    body: JSON.stringify({
      email: `pds-pairing-${randomUUID()}@example.test`,
      password: `pds-e2e-${randomUUID()}`
    })
  });
  const session = registration.headers
    .get("set-cookie")
    ?.match(/(?:^|,\s*)cm_session=([^;]+)/)?.[1];
  if (!registration.ok || !session) {
    throw new Error(
      "Synthetic PDS test User registration failed. Supply PDS_E2E_BROWSER_COOKIE instead."
    );
  }
  browserCookie = `cm_session=${session}`;
}
if (!desktopAuthorization && !browserCookie) {
  throw new Error(
    "PDS_E2E_DESKTOP_AUTHORIZATION or PDS_E2E_BROWSER_COOKIE is required unless PDS_E2E_ALLOW_REGISTER=1."
  );
}
if (
  joiningControlUrl &&
  !joiningDesktopAuthorization &&
  !joiningBrowserCookie
) {
  throw new Error(
    "PDS_E2E_JOINING_DESKTOP_AUTHORIZATION or PDS_E2E_JOINING_BROWSER_COOKIE is required for two-database validation."
  );
}
const root = mkdtempSync(resolve(tmpdir(), "koed-pds-pairing-e2e-"));
const homes = {
  a: resolve(root, "device-a"),
  b: resolve(root, "device-b")
};
const secrets = {
  a: new Map(),
  b: new Map()
};
let pairingServer = null;

const secretDependencies = (device) => ({
  putSecret: (reference, value) => secrets[device].set(reference, value),
  getSecret: (reference) => secrets[device].get(reference) ?? null,
  deleteSecret: (reference) => secrets[device].delete(reference)
});

const environmentFor = (device, overrides = {}) => ({
  KOED_HOME: homes[device],
  KOED_REPO_ROOT: process.cwd(),
  PDS_BROWSER_ORIGIN: browserOrigin,
  PDS_CONTROL_URL: controlUrl,
  PDS_RUNTIME_SECRET_REF: `pds-runtime-${device}`,
  ...overrides
});

const withJsonFd = async (name, value, operation) => {
  const path = resolve(root, `${name}-${randomUUID()}.json`);
  writeFileSync(path, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  const fd = openSync(path, "r");
  try {
    return await operation(fd);
  } finally {
    closeSync(fd);
    unlinkSync(path);
  }
};

const withTextFd = async (name, value, operation) => {
  const path = resolve(root, `${name}-${randomUUID()}.txt`);
  writeFileSync(path, value, { mode: 0o600, flag: "wx" });
  const fd = openSync(path, "r");
  try {
    return await operation(fd);
  } finally {
    closeSync(fd);
    unlinkSync(path);
  }
};

const command = (device, args, overrides = {}) =>
  runPersonalSyncCommand(
    args,
    resolveKoedServerPaths(environmentFor(device)),
    environmentFor(device, overrides.environment),
    {
      ...secretDependencies(device),
      ...(desktopAuthorization ? { desktopAuthorization } : {}),
      ...overrides.dependencies
    }
  );

const exchange = async (pairingUrl, payload, timeoutMs = 10_000) => {
  const parsed = new URL(pairingUrl);
  const invitationId = parsed.pathname.split("/").at(-1);
  const token = parsed.hash.slice("#token=".length);
  const encrypted = encryptPersonalDevicePairingMessage(payload, {
    invitationId,
    token,
    direction: "request"
  });
  const response = await fetch(
    `${parsed.origin}/v1/pair/${invitationId}/exchange`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json"
      },
      body: JSON.stringify(encrypted),
      signal: AbortSignal.timeout(timeoutMs)
    }
  );
  const body = await response.json();
  if (!response.ok) {
    throw new Error(
      typeof body?.error === "string"
        ? body.error
        : `Pairing exchange failed (${response.status}).`
    );
  }
  const opened = decryptPersonalDevicePairingMessage(body, {
    invitationId,
    token,
    direction: "response"
  });
  if (opened.messageId !== encrypted.message_id) {
    throw new Error("Pairing response is not bound to its request.");
  }
  return opened.value;
};

const pairingControlFetch = (pairingUrl, controlEndpoint) => {
  const control = new URL(controlEndpoint);
  const controlPrefix = control.toString().replace(/\/$/, "");
  return async (input, init = {}) => {
    const requested = new URL(String(input));
    if (
      requested.origin !== control.origin ||
      !requested.toString().startsWith(`${controlPrefix}/`)
    ) {
      throw new Error("Pairing control request escaped its invitation.");
    }
    const method = init.method ?? "GET";
    if (method !== "GET" && method !== "POST") {
      throw new Error("Pairing control method is invalid.");
    }
    const headers = new Headers(init.headers);
    const result = await exchange(pairingUrl, {
      operation: "control",
      method,
      path: requested.toString().slice(controlPrefix.length),
      headers: Object.fromEntries(
        ["accept", "content-type"].flatMap((name) => {
          const value = headers.get(name);
          return value ? [[name, value]] : [];
        })
      ),
      ...(typeof init.body === "string" ? { body: init.body } : {})
    });
    return new Response(result.body, {
      status: result.status,
      headers: result.headers
    });
  };
};

try {
  const recoveryKit = resolve(root, "recovery-kit.json");
  const bootstrap = await withTextFd(
    "recovery-password",
    "personal-device-pairing-e2e-password",
    async (passwordFd) =>
      await command(
        "a",
        [
          "group",
          "bootstrap",
          "--recovery-kit",
          recoveryKit,
          "--password-fd",
          String(passwordFd)
        ],
        {
          dependencies: {
            ...(desktopAuthorization
              ? { desktopAuthorization }
              : { sessionCookie: browserCookie }),
            identity: {
              remoteOperationsAllowed: true,
              deploymentId: randomUUID(),
              deviceInstanceId: randomUUID()
            }
          }
        }
      )
  );
  const groupId = bootstrap.groupId;
  const invitationBase = await command(
    "a",
    ["invite", "create", "--group-id", groupId],
    {
      dependencies: desktopAuthorization
        ? { desktopAuthorization }
        : { sessionCookie: browserCookie }
    }
  );

  pairingServer = await startPersonalDevicePairingServer({
    port: 0,
    host: "127.0.0.1",
    addresses: () => ["127.0.0.1"],
    forwardControl: async ({ method, path, headers, body }) => {
      const response = await fetch(new URL(path, controlUrl), {
        method,
        headers: {
          accept: "application/json",
          ...(desktopAuthorization
            ? { authorization: desktopAuthorization }
            : { cookie: browserCookie, origin: browserOrigin }),
          ...headers
        },
        ...(body === undefined ? {} : { body })
      });
      return {
        status: response.status,
        headers: {
          "content-type":
            response.headers.get("content-type") ??
            "application/json; charset=utf-8"
        },
        body: await response.text()
      };
    }
  });
  const pairing = pairingServer.createInvitation(invitationBase.invitation);
  const invitationResult = await exchange(pairing.url, {
    operation: "invitation"
  });
  const invitation = invitationResult.invitation;
  const joiningRequest = await withJsonFd(
    "invitation",
    invitation,
    async (invitationFd) =>
      await command(
        "b",
        [
          "join",
          "request",
          "--group-id",
          groupId,
          "--invitation-fd",
          String(invitationFd)
        ],
        {
          environment: {
            PDS_CONTROL_URL: invitation.control_url
          },
          dependencies: {
            pairingToken: new URL(pairing.url).hash.slice("#token=".length),
            identity: {
              remoteOperationsAllowed: true,
              deploymentId: randomUUID(),
              deviceInstanceId: randomUUID()
            }
          }
        }
      )
  );
  const approvalResponse = exchange(
    pairing.url,
    {
      operation: "request",
      request: joiningRequest.request,
      device_label: "Pairing E2E Device B"
    },
    60_000
  );
  const pendingRequest = await pairingServer.waitForRequest(pairing.id);
  const approval = await withJsonFd(
    "joining-request",
    { request: pendingRequest },
    async (requestFd) =>
      await command(
        "a",
        ["active-device", "approve", "--request-fd", String(requestFd)],
        {
          dependencies: desktopAuthorization
            ? { desktopAuthorization }
            : { sessionCookie: browserCookie }
        }
      )
  );
  pairingServer.approve(pairing.id);
  const approved = await approvalResponse;
  if (approved.approved !== true) {
    throw new Error("Joining device did not receive explicit approval.");
  }

  const pairingFetch = pairingControlFetch(pairing.url, invitation.control_url);
  const completion = await command(
    "b",
    [
      "join",
      "complete",
      "--group-id",
      groupId,
      "--challenge-id",
      invitation.challenge_id
    ],
    {
      environment: {
        PDS_CONTROL_URL: invitation.control_url
      },
      dependencies: {
        pairingToken: new URL(pairing.url).hash.slice("#token=".length),
        fetch: pairingFetch
      }
    }
  );
  let joiningDatabase = null;
  if (joiningControlUrl) {
    const localGroupReconciliation = completion.localGroupReconciliation;
    if (
      !localGroupReconciliation ||
      typeof localGroupReconciliation !== "object" ||
      Array.isArray(localGroupReconciliation)
    ) {
      throw new Error(
        "Joining-device completion omitted local group reconciliation."
      );
    }
    joiningDatabase = await reconcileJoiningDeviceDatabase({
      authorityControlUrl: controlUrl,
      joiningControlUrl,
      desktopAuthorization: joiningDesktopAuthorization,
      browserCookie: joiningBrowserCookie,
      groupId,
      localGroupReconciliation,
      fetch
    });
    await command(
      "b",
      [
        "join",
        "bind-local-user",
        "--group-id",
        groupId,
        "--user-id",
        joiningDatabase.localUserId,
        "--challenge-id",
        invitation.challenge_id
      ],
      {
        environment: {
          PDS_CONTROL_URL: joiningControlUrl
        }
      }
    );
  }
  const closed = await exchange(pairing.url, { operation: "complete" });
  if (closed.completed !== true) {
    throw new Error("Pairing invitation did not close.");
  }
  const refreshed = await command("a", ["active-device", "refresh"], {
    dependencies: desktopAuthorization
      ? { desktopAuthorization }
      : { sessionCookie: browserCookie }
  });
  const groupResponse = await fetch(
    `${controlUrl}/v1/personal-device-sync/groups/${encodeURIComponent(groupId)}`,
    {
      headers: {
        accept: "application/json",
        ...(desktopAuthorization
          ? { authorization: desktopAuthorization }
          : { cookie: browserCookie, origin: browserOrigin })
      }
    }
  );
  const groupPayload = await groupResponse.json();
  const activeMembers = groupPayload.group?.members?.filter(
    (member) => member.status === "active"
  );
  const runtimeA = JSON.parse(secrets.a.get("pds-runtime-a"));
  const runtimeB = JSON.parse(secrets.b.get("pds-runtime-b"));
  if (
    groupResponse.status !== 200 ||
    activeMembers?.length !== 2 ||
    groupPayload.group.pending_epoch !== null ||
    runtimeA.groupSecrets.currentEpoch !== "2" ||
    runtimeB.groupSecrets.currentEpoch !== "2" ||
    runtimeA.device.id === runtimeB.device.id ||
    !runtimeB.relayUrl.startsWith(`http://127.0.0.1:${pairingServer.port}/pds`)
  ) {
    throw new Error("Two-device enrollment invariant failed.");
  }
  const invalidated = await fetch(
    `http://127.0.0.1:${pairingServer.port}/v1/pair/${pairing.id}/exchange`,
    { method: "POST", body: "{}" }
  );
  if (invalidated.status !== 410) {
    throw new Error("Completed invitation remained usable.");
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        groupId,
        activeMembers: activeMembers.length,
        epoch: runtimeA.groupSecrets.currentEpoch,
        sourceState: approval.state,
        joiningState: completion.state,
        joiningDatabase:
          joiningDatabase === null
            ? { state: "single-control-database" }
            : {
                state: "reconciled",
                distinctControlOrigin: true,
                localUserId: joiningDatabase.localUserId
              },
        sourceRefreshState: refreshed.state,
        invitationInvalidated: true,
        secretsEmitted: false
      },
      null,
      2
    )}\n`
  );
} finally {
  await pairingServer?.close();
  rmSync(root, { recursive: true, force: true });
}
