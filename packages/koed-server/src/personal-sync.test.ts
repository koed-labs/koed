import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseCanonicalPdsJson,
  signPdsRecord,
  validatePdsGroupStatement,
  verifyPdsEnrollmentProof
} from "@koed/shared";
import {
  decryptRecoveryKit,
  encryptRecoveryKit,
  personalSyncProviderEnvironment,
  runPersonalSyncCommand
} from "./personal-sync.js";

const roots: string[] = [];
const root = () => {
  const value = mkdtempSync(resolve(tmpdir(), "koed-pds-control-"));
  roots.push(value);
  return value;
};
afterEach(() =>
  roots
    .splice(0)
    .forEach((directory) => rmSync(directory, { recursive: true, force: true }))
);

const fdFor = (directory: string, name: string, value: string) => {
  const path = resolve(directory, name);
  writeFileSync(path, value, { mode: 0o600 });
  return openSync(path, "r");
};
const pathsFor = (directory: string) =>
  ({ configDir: resolve(directory, "config") }) as never;

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });

const controlEnv = (fd: number) => ({
  PDS_CONTROL_URL: "https://pds.test",
  PDS_BROWSER_ORIGIN: "https://explorer.pds.test",
  PDS_BROWSER_SESSION_FD: String(fd)
});

describe("Personal Sync control client", () => {
  it("runs the Desktop secret bridge provider through Electron's Node mode", () => {
    expect(
      personalSyncProviderEnvironment({
        ELECTRON_RUN_AS_NODE: undefined,
        PDS_SECRET_PROVIDER: "desktop_bridge"
      }).ELECTRON_RUN_AS_NODE
    ).toBe("1");
    expect(
      personalSyncProviderEnvironment({
        ELECTRON_RUN_AS_NODE: "custom",
        PDS_SECRET_PROVIDER: "headless"
      }).ELECTRON_RUN_AS_NODE
    ).toBe("custom");
  });

  it("uses versioned scrypt/AES-GCM with metadata AAD", () => {
    const password = Buffer.from("correct horse battery staple");
    const kit = encryptRecoveryKit('{"groupId":"pds_test"}', password);
    expect(decryptRecoveryKit(kit, password)).toBe('{"groupId":"pds_test"}');
    const invalidParameters = JSON.parse(JSON.stringify(kit)) as typeof kit;
    (invalidParameters.kdf as { p: number }).p = 2;
    expect(() => decryptRecoveryKit(invalidParameters, password)).toThrow(
      "Recovery kit format is invalid."
    );
    expect(() =>
      decryptRecoveryKit(
        {
          ...kit,
          cipher: {
            ...kit.cipher,
            nonce: `${kit.cipher.nonce[0] === "A" ? "B" : "A"}${kit.cipher.nonce.slice(1)}`
          }
        },
        password
      )
    ).toThrow("Recovery kit password or authentication tag is invalid.");
  });

  it("fails closed without browser-session FD and never reports local policy", async () => {
    await expect(
      runPersonalSyncCommand(["status"], pathsFor(root()), {
        PDS_CONTROL_URL: "https://pds.test"
      })
    ).rejects.toThrow("browser session FD");
  });

  it("reports backend status through bounded session-authenticated control API", async () => {
    const directory = root();
    const sessionFd = fdFor(directory, "session", "cm_session=browser-only");
    const fetch = async (url: string | URL, options?: RequestInit) => {
      expect(String(url)).toBe(
        "https://pds.test/v1/personal-device-sync/groups"
      );
      expect(options?.headers).toMatchObject({
        cookie: "cm_session=browser-only"
      });
      return response({
        groups: [{ group_id: "pds_one", state: "active" }],
        pairing_invitation_group_ids: ["pds_one"]
      });
    };
    try {
      await expect(
        runPersonalSyncCommand(
          ["status"],
          pathsFor(directory),
          controlEnv(sessionFd),
          { fetch: fetch as never }
        )
      ).resolves.toMatchObject({
        state: "backend",
        groups: [{ group_id: "pds_one" }],
        pairing_invitation_group_ids: ["pds_one"]
      });
    } finally {
      closeSync(sessionFd);
    }
  });

  it("fails visibly when secure runtime state is corrupt", async () => {
    const directory = root();
    const sessionFd = fdFor(directory, "session", "cm_session=browser-only");
    try {
      await expect(
        runPersonalSyncCommand(
          ["status"],
          pathsFor(directory),
          {
            ...controlEnv(sessionFd),
            PDS_RUNTIME_SECRET_REF: "pds-runtime"
          },
          {
            fetch: (() =>
              response({
                groups: [],
                pairing_invitation_group_ids: []
              })) as never,
            getSecret: () => '{"version":1,"corrupt":true}'
          }
        )
      ).rejects.toThrow("PDS runtime secret is invalid.");
    } finally {
      closeSync(sessionFd);
    }
  });

  it("never places a LAN pairing secret in request headers", async () => {
    const pairingToken = Buffer.alloc(32, 9).toString("base64url");
    const fetch = async (_url: string | URL, options?: RequestInit) => {
      const headers = new Headers(options?.headers);
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("cookie")).toBeNull();
      expect(JSON.stringify(options)).not.toContain(pairingToken);
      return response({ groups: [], pairing_invitation_group_ids: [] });
    };
    await expect(
      runPersonalSyncCommand(
        ["status"],
        pathsFor(root()),
        { PDS_CONTROL_URL: "http://192.168.1.10:3310/exchange" },
        { fetch: fetch as never, pairingToken }
      )
    ).resolves.toMatchObject({ ok: true, groups: [] });
  });

  it("persists only redacted backend pairing request IDs", async () => {
    const directory = root();
    const sessionFd = fdFor(directory, "session", "cm_session=browser-only");
    const storedSecrets: string[] = [];
    const fetch = async (_url: string | URL, options?: RequestInit) => {
      const request = JSON.parse(String(options?.body)) as Record<
        string,
        unknown
      >;
      expect(request.challenge_hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
      return response({
        challenge: {
          id: "d3d89391-d05a-4d4e-b33f-4d7859a1ce45",
          short_code: "D3D89391",
          expires_at: "2099-07-15T13:00:00.000Z",
          browser_subject_id: "browser-user",
          browser_deployment_id: "browser-deployment",
          authority: {
            key_id: "authority-key",
            public_key: Buffer.alloc(32, 7).toString("base64url")
          }
        }
      });
    };
    try {
      const requested = await runPersonalSyncCommand(
        ["join", "request", "--group-id", "pds_one"],
        pathsFor(directory),
        {
          ...controlEnv(sessionFd),
          PDS_RUNTIME_SECRET_REF: "pds-runtime"
        },
        {
          fetch: fetch as never,
          identity: {
            remoteOperationsAllowed: true,
            deploymentId: "local-deployment",
            deviceInstanceId: "local-device"
          },
          putSecret: (_reference, secret) => {
            storedSecrets.push(secret);
          }
        }
      );
      expect(requested).toMatchObject({
        request: {
          group_id: "pds_one",
          operation_families: ["pds_relay"]
        }
      });
      expect((requested.request as { device_id: string }).device_id).toMatch(
        /^[A-Za-z0-9_-]{22}$/
      );
      expect(storedSecrets).toHaveLength(1);
      expect(storedSecrets[0]).not.toContain("cm_session");
      const result = await runPersonalSyncCommand(
        ["join", "challenge"],
        pathsFor(directory),
        controlEnv(sessionFd),
        { fetch: fetch as never }
      );
      expect(result).toMatchObject({
        requests: [
          {
            requestId: "d3d89391-d05a-4d4e-b33f-4d7859a1ce45",
            groupId: "pds_one"
          }
        ]
      });
    } finally {
      closeSync(sessionFd);
    }
  });

  it("creates a signed join request from one exact, short-lived LAN invitation without browser auth", async () => {
    const directory = root();
    const invitation = {
      protocol: "koed/pds-lan-pair/v1",
      group_id: "pds_one",
      challenge_id: "d3d89391-d05a-4d4e-b33f-4d7859a1ce45",
      challenge: Buffer.alloc(32, 4).toString("base64url"),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      browser_subject_id: "browser-user",
      browser_deployment_id: "browser-deployment",
      authority: {
        key_id: "authority-key",
        public_key: Buffer.alloc(32, 7).toString("base64url")
      },
      control_url:
        "http://192.168.1.10:3310/v1/pair/11111111-2222-4333-8444-555555555555/exchange",
      relay_url: "http://192.168.1.10:3310/pds"
    };
    const invitationFd = fdFor(
      directory,
      "invitation",
      JSON.stringify(invitation)
    );
    const stored = new Map<string, string>();
    try {
      const result = await runPersonalSyncCommand(
        [
          "join",
          "request",
          "--group-id",
          "pds_one",
          "--invitation-fd",
          String(invitationFd)
        ],
        pathsFor(directory),
        {
          PDS_CONTROL_URL: invitation.control_url,
          PDS_RUNTIME_SECRET_REF: "pds-runtime"
        },
        {
          pairingToken: Buffer.alloc(32, 9).toString("base64url"),
          fetch: (() => {
            throw new Error(
              "Supplied invitation must not fetch a new challenge."
            );
          }) as never,
          identity: {
            remoteOperationsAllowed: true,
            deploymentId: "joining-deployment",
            deviceInstanceId: "joining-device"
          },
          putSecret: (reference, value) => {
            stored.set(reference, value);
          },
          getSecret: (reference) => stored.get(reference) ?? null
        }
      );
      expect(result).toMatchObject({
        state: "pending",
        pairing: {
          challengeId: invitation.challenge_id,
          shortCode: "D3D89391"
        },
        request: {
          group_id: "pds_one",
          operation_families: ["pds_relay"]
        }
      });
      expect((result.request as { device_id: string }).device_id).toMatch(
        /^[A-Za-z0-9_-]{22}$/
      );
      expect(stored.size).toBe(1);
      const pendingSecret = [...stored.values()][0]!;
      const pendingRuntime = JSON.parse(pendingSecret) as {
        originDeploymentId: string;
      };
      expect(pendingRuntime).toMatchObject({
        groupId: "pds_one",
        userId: "browser-user",
        browserDeploymentId: "browser-deployment",
        localDeploymentId: "joining-deployment",
        relayUrl: invitation.relay_url,
        deviceId: (result.request as { device_id: string }).device_id,
        authorityKeyId: "authority-key",
        challenge: invitation.challenge,
        expiresAt: invitation.expires_at
      });
      expect(pendingRuntime.originDeploymentId).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(pendingSecret).not.toContain("pairingToken");

      const retryFd = fdFor(
        directory,
        "invitation-retry",
        JSON.stringify(invitation)
      );
      try {
        const retry = await runPersonalSyncCommand(
          [
            "join",
            "request",
            "--group-id",
            "pds_one",
            "--invitation-fd",
            String(retryFd)
          ],
          pathsFor(directory),
          {
            PDS_CONTROL_URL: invitation.control_url,
            PDS_RUNTIME_SECRET_REF: "pds-runtime"
          },
          {
            pairingToken: Buffer.alloc(32, 9).toString("base64url"),
            identity: {
              remoteOperationsAllowed: true,
              deploymentId: "joining-deployment",
              deviceInstanceId: "joining-device"
            },
            putSecret: (reference, value) => {
              stored.set(reference, value);
            },
            getSecret: (reference) => stored.get(reference) ?? null
          }
        );
        expect(retry.request).toEqual(result.request);
        expect(stored.size).toBe(1);
      } finally {
        closeSync(retryFd);
      }
    } finally {
      closeSync(invitationFd);
    }
  });

  it("rejects altered, expired, cross-group, and overlong LAN invitations", async () => {
    const directory = root();
    const valid = {
      protocol: "koed/pds-lan-pair/v1",
      group_id: "pds_one",
      challenge_id: "d3d89391-d05a-4d4e-b33f-4d7859a1ce45",
      challenge: Buffer.alloc(32, 4).toString("base64url"),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      browser_subject_id: "browser-user",
      browser_deployment_id: "browser-deployment",
      authority: {
        key_id: "authority-key",
        public_key: Buffer.alloc(32, 7).toString("base64url")
      },
      control_url: "http://192.168.1.10:3310/exchange",
      relay_url: "http://192.168.1.10:3310/pds"
    };
    for (const [name, invitation] of [
      ["extra", { ...valid, unexpected: true }],
      [
        "expired",
        { ...valid, expires_at: new Date(Date.now() - 1).toISOString() }
      ],
      ["cross-group", { ...valid, group_id: "pds_other" }],
      [
        "overlong",
        {
          ...valid,
          expires_at: new Date(Date.now() + 11 * 60 * 1_000).toISOString()
        }
      ]
    ] as const) {
      const fd = fdFor(
        directory,
        `invitation-${name}`,
        JSON.stringify(invitation)
      );
      try {
        await expect(
          runPersonalSyncCommand(
            [
              "join",
              "request",
              "--group-id",
              "pds_one",
              "--invitation-fd",
              String(fd)
            ],
            pathsFor(directory),
            {
              PDS_CONTROL_URL: valid.control_url,
              PDS_RUNTIME_SECRET_REF: "pds-runtime"
            },
            {
              pairingToken: Buffer.alloc(32, 9).toString("base64url"),
              identity: {
                remoteOperationsAllowed: true,
                deploymentId: "joining-deployment",
                deviceInstanceId: "joining-device"
              },
              putSecret: () => undefined
            }
          )
        ).rejects.toThrow("pairing invitation");
      } finally {
        closeSync(fd);
      }
    }
  });

  it("bootstraps a signed group, verifies recovery material, and stores runtime secrets by reference", async () => {
    const directory = root();
    const sessionFd = fdFor(directory, "session", "cm_session=browser-only");
    const passwordFd = fdFor(directory, "password", "recovery password");
    const recoveryKit = resolve(directory, "recovery-kit.json");
    const authority = generateKeyPairSync("ed25519");
    const authorityPublicKey = (
      authority.publicKey.export({ format: "jwk" }) as { x: string }
    ).x;
    const stored: Array<{ reference: string; value: string }> = [];
    let submittedStatement: Record<string, unknown> | null = null;
    let submittedProof: Record<string, unknown> | null = null;
    const fetch = async (url: string | URL, options?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const body = options?.body
        ? (JSON.parse(String(options.body)) as Record<string, unknown>)
        : {};
      if (path.endsWith("/challenges")) {
        expect(body.challenge_hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
        return response({
          challenge: {
            id: "11111111-1111-4111-8111-111111111111",
            short_code: "11111111",
            expires_at: "2099-07-15T13:00:00.000Z",
            browser_subject_id: "browser-user",
            browser_deployment_id: "browser-deployment",
            authority: {
              key_id: "authority-key",
              public_key: authorityPublicKey
            }
          }
        });
      }
      if (path.endsWith("/groups/genesis")) {
        submittedStatement = parseCanonicalPdsJson(
          String(body.statement)
        ) as Record<string, unknown>;
        submittedProof = body.proof as Record<string, unknown>;
        const draft = submittedStatement.draft as Record<string, unknown>;
        const statementBody = draft.body as Record<string, unknown>;
        validatePdsGroupStatement(submittedStatement, {
          authorizationPublicKey: String(
            statementBody.initialDeviceSigningPublicKey
          ),
          expectedGroupId: String(draft.groupId),
          expectedPreviousHash: null,
          expectedSequence: "1"
        });
        verifyPdsEnrollmentProof({
          challengeId: String(submittedProof.challenge_id),
          challenge: String(submittedProof.challenge),
          groupId: String(draft.groupId),
          deviceId: String(submittedProof.device_id),
          deviceSigningKeyId: String(statementBody.initialDeviceSigningKeyId),
          deviceSigningPublicKey: String(
            statementBody.initialDeviceSigningPublicKey
          ),
          deviceKemKeyId: String(statementBody.initialDeviceKemKeyId),
          deviceKemPublicKey: String(statementBody.initialDeviceKemPublicKey),
          browserSubjectId: "browser-user",
          browserDeploymentId: "browser-deployment",
          expiresAt: String(submittedProof.expires_at),
          signature: String(submittedProof.signature)
        });
        return response({
          group: {
            group_id: draft.groupId,
            current_epoch: "1",
            head: {
              sequence: "1",
              hash: Buffer.alloc(32, 12).toString("base64url")
            }
          },
          statement: submittedStatement
        });
      }
      if (path.includes("/certificates/")) {
        const draft = submittedStatement?.draft as Record<string, unknown>;
        const statementBody = draft.body as Record<string, unknown>;
        const unsigned = {
          protocol: "koed/pds/v1",
          groupId: draft.groupId,
          deviceId: statementBody.initialDeviceId,
          deviceSigningKeyId: statementBody.initialDeviceSigningKeyId,
          deviceSigningPublicKey: statementBody.initialDeviceSigningPublicKey,
          deviceKemKeyId: statementBody.initialDeviceKemKeyId,
          deviceKemPublicKey: statementBody.initialDeviceKemPublicKey,
          epoch: "1",
          operationFamilies: ["pds_relay"],
          statementSequence: "1",
          statementHash: Buffer.alloc(32, 12).toString("base64url"),
          issuedAt: new Date(Date.now() - 1_000).toISOString(),
          expiresAt: new Date(Date.now() + 86_400_000).toISOString()
        };
        return response({
          certificate: {
            ...unsigned,
            authoritySignature: {
              keyId: "authority-key",
              signature: signPdsRecord(
                "membership-certificate",
                unsigned,
                authority.privateKey
              )
            }
          }
        });
      }
      if (path.endsWith("/policy"))
        return response({ policy: { enabled: true } });
      throw new Error(`Unexpected control request ${path}`);
    };
    try {
      const result = await runPersonalSyncCommand(
        [
          "group",
          "bootstrap",
          "--recovery-kit",
          recoveryKit,
          "--password-fd",
          String(passwordFd)
        ],
        pathsFor(directory),
        {
          ...controlEnv(sessionFd),
          PDS_RUNTIME_SECRET_REF: "pds-runtime"
        },
        {
          fetch: fetch as never,
          identity: {
            remoteOperationsAllowed: true,
            deploymentId: "local-deployment",
            deviceInstanceId: "local-device"
          },
          putSecret: (reference, value) => {
            stored.push({ reference, value });
          }
        }
      );
      expect(result).toMatchObject({
        ok: true,
        state: "active",
        recoveryKit
      });
      expect(result.deviceId).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(submittedStatement).not.toBeNull();
      expect(submittedProof).not.toBeNull();
      expect(stored).toHaveLength(1);
      expect(stored[0]?.reference).toBe("pds-runtime");
      const storedRuntime = JSON.parse(stored[0]!.value) as {
        device: { originDeploymentId: string };
      };
      expect(storedRuntime).toMatchObject({
        version: 1,
        userId: "browser-user",
        device: {
          id: result.deviceId
        }
      });
      expect(storedRuntime.device.originDeploymentId).toMatch(
        /^[A-Za-z0-9_-]{22}$/
      );
      const statusSessionFd = fdFor(
        directory,
        "status-session",
        "cm_session=browser-only"
      );
      try {
        await expect(
          runPersonalSyncCommand(
            ["status"],
            pathsFor(directory),
            {
              ...controlEnv(statusSessionFd),
              PDS_RUNTIME_SECRET_REF: "pds-runtime"
            },
            {
              fetch: (() =>
                response({
                  groups: [],
                  pairing_invitation_group_ids: []
                })) as never,
              getSecret: () => stored.at(-1)?.value ?? null
            }
          )
        ).resolves.toMatchObject({
          state: "local_binding_missing",
          recoveryRequired: true,
          groups: [],
          pairing_invitation_group_ids: []
        });
      } finally {
        closeSync(statusSessionFd);
      }
      const localUserId = "22222222-2222-4222-8222-222222222222";
      await expect(
        runPersonalSyncCommand(
          [
            "join",
            "bind-local-user",
            "--group-id",
            String(result.groupId),
            "--user-id",
            localUserId
          ],
          pathsFor(directory),
          {
            ...controlEnv(sessionFd),
            PDS_RUNTIME_SECRET_REF: "pds-runtime"
          },
          {
            getSecret: () => stored.at(-1)?.value ?? null,
            putSecret: (reference, value) => {
              stored.push({ reference, value });
            }
          }
        )
      ).resolves.toMatchObject({
        ok: true,
        state: "active",
        groupId: result.groupId,
        deviceId: result.deviceId
      });
      expect(JSON.parse(stored.at(-1)!.value)).toMatchObject({
        userId: localUserId,
        groupId: result.groupId
      });
      const parsedRecoveryKit: unknown = JSON.parse(
        readFileSync(recoveryKit, "utf8")
      );
      expect(() =>
        decryptRecoveryKit(
          parsedRecoveryKit as Parameters<typeof decryptRecoveryKit>[0],
          Buffer.from("recovery password")
        )
      ).not.toThrow();
    } finally {
      closeSync(passwordFd);
      closeSync(sessionFd);
    }
  });

  it("does not commit recovery material or runtime secrets when genesis is rejected", async () => {
    const directory = root();
    const sessionFd = fdFor(directory, "session", "cm_session=browser-only");
    const passwordFd = fdFor(directory, "password", "recovery password");
    const recoveryKit = resolve(directory, "recovery-kit.json");
    const stored: string[] = [];
    const authorityPublicKey = Buffer.alloc(32, 11).toString("base64url");
    const fetch = async (url: string | URL) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/challenges"))
        return response({
          challenge: {
            id: "11111111-1111-4111-8111-111111111111",
            short_code: "11111111",
            expires_at: "2099-07-15T13:00:00.000Z",
            browser_subject_id: "browser-user",
            browser_deployment_id: "browser-deployment",
            authority: {
              key_id: "authority-key",
              public_key: authorityPublicKey
            }
          }
        });
      if (path.endsWith("/groups/genesis"))
        return new Response(JSON.stringify({ error: "genesis rejected" }), {
          status: 409,
          headers: { "content-type": "application/json" }
        });
      throw new Error(`Unexpected control request ${path}`);
    };
    try {
      await expect(
        runPersonalSyncCommand(
          [
            "group",
            "bootstrap",
            "--recovery-kit",
            recoveryKit,
            "--password-fd",
            String(passwordFd)
          ],
          pathsFor(directory),
          {
            ...controlEnv(sessionFd),
            PDS_RUNTIME_SECRET_REF: "pds-runtime"
          },
          {
            fetch: fetch as never,
            identity: {
              remoteOperationsAllowed: true,
              deploymentId: "local-deployment",
              deviceInstanceId: "local-device"
            },
            putSecret: (_reference, value) => {
              stored.push(value);
            }
          }
        )
      ).rejects.toThrow("genesis rejected");
      expect(existsSync(recoveryKit)).toBe(false);
      expect(stored).toEqual([]);
      expect(
        readdirSync(directory).filter((entry) => entry.endsWith(".tmp"))
      ).toEqual([]);
    } finally {
      closeSync(passwordFd);
      closeSync(sessionFd);
    }
  });

  it("requires signed transition payload from protected FDs; arbitrary device IDs cannot succeed", async () => {
    const directory = root();
    const sessionFd = fdFor(directory, "session", "cm_session=browser-only");
    try {
      await expect(
        runPersonalSyncCommand(
          [
            "device",
            "revoke",
            "--group-id",
            "pds_one",
            "--device-id",
            "arbitrary"
          ],
          pathsFor(directory),
          controlEnv(sessionFd)
        )
      ).rejects.toThrow("--statement-fd is required.");
    } finally {
      closeSync(sessionFd);
    }
  });
});
