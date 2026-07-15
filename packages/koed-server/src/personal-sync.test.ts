import {
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decryptRecoveryKit,
  encryptRecoveryKit,
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
  PDS_BROWSER_SESSION_FD: String(fd)
});

describe("Personal Sync control client", () => {
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
      return response({ groups: [{ group_id: "pds_one", state: "active" }] });
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
        groups: [{ group_id: "pds_one" }]
      });
    } finally {
      closeSync(sessionFd);
    }
  });

  it("persists only redacted backend pairing request IDs", async () => {
    const directory = root();
    const sessionFd = fdFor(directory, "session", "cm_session=browser-only");
    const fetch = async () =>
      response({
        challenge: {
          id: "d3d89391-d05a-4d4e-b33f-4d7859a1ce45",
          short_code: "D3D89391",
          expires_at: "2026-07-15T13:00:00.000Z"
        }
      });
    try {
      await runPersonalSyncCommand(
        ["join", "request", "--group-id", "pds_one"],
        pathsFor(directory),
        controlEnv(sessionFd),
        { fetch: fetch as never }
      );
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
