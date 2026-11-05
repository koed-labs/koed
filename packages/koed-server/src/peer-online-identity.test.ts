import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPeerOnlineIdentity as createIdentity,
  loadPeerOnlineIdentity
} from "./peer-online-identity.js";

const authorizeFreshInstall = async () => true;
const createPeerOnlineIdentity = (root: string) =>
  createIdentity(root, authorizeFreshInstall);
const homes: string[] = [];
function home(): string {
  const path = mkdtempSync(join(tmpdir(), "koed-peer-identity-"));
  homes.push(path);
  return path;
}
afterEach(() => {
  for (const path of homes.splice(0))
    rmSync(path, { recursive: true, force: true });
});

describe("peer online identity", () => {
  it("persists independent keys encrypted across loads", async () => {
    const root = home();
    expect(await loadPeerOnlineIdentity(root)).toBeNull();
    const created = await createPeerOnlineIdentity(root);
    const loaded = await loadPeerOnlineIdentity(root);
    expect(loaded?.publicIdentity).toEqual(created.publicIdentity);
    expect(loaded?.getRuntimeKeys()).toEqual(created.getRuntimeKeys());
    expect(created.publicIdentity.signingPublicKey).not.toBe(
      created.publicIdentity.encryptionPublicKey
    );
    expect(Object.keys(created.publicIdentity).sort()).toEqual([
      "deviceId",
      "encryptionPublicKey",
      "signingPublicKey"
    ]);
    expect(statSync(join(root, "peer-online-identity")).mode & 0o777).toBe(
      0o700
    );
    const secrets = join(root, "secrets");
    const persisted = readdirSync(secrets)
      .map((f) => readFileSync(join(secrets, f)).toString())
      .join("\n");
    for (const key of Object.values(created.getRuntimeKeys()))
      expect(persisted).not.toContain(key);
  });

  it("serializes independent concurrent creators without replacing identity", async () => {
    const root = home();
    const results = await Promise.allSettled([
      createPeerOnlineIdentity(root),
      createPeerOnlineIdentity(root)
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected")
    ).toHaveLength(1);
    const winner = results.find((result) => result.status === "fulfilled");
    if (winner?.status !== "fulfilled") throw new Error("missing winner");
    expect((await loadPeerOnlineIdentity(root))?.publicIdentity).toEqual(
      winner.value.publicIdentity
    );
  });

  it("fails closed when persisted identity is missing or corrupt", async () => {
    const root = home();
    await createPeerOnlineIdentity(root);
    const store = join(root, "secrets", "peer-online-identity.json");
    unlinkSync(store);
    await expect(loadPeerOnlineIdentity(root)).rejects.toThrow();
    await expect(createPeerOnlineIdentity(root)).rejects.toThrow();
    writeFileSync(store, "bad", { mode: 0o600 });
    await expect(loadPeerOnlineIdentity(root)).rejects.toThrow();
    await expect(createPeerOnlineIdentity(root)).rejects.toThrow();
  });

  it("fails closed if the encryption key is missing", async () => {
    const root = home();
    await createPeerOnlineIdentity(root);
    unlinkSync(join(root, "secrets", "peer-online-identity.key"));
    await expect(loadPeerOnlineIdentity(root)).rejects.toThrow();
    await expect(createPeerOnlineIdentity(root)).rejects.toThrow();
  });

  it("requires external fresh-install authorization even after total loss", async () => {
    const root = home();
    await expect(createIdentity(root, async () => false)).rejects.toThrow();
    await createPeerOnlineIdentity(root);
    rmSync(join(root, "peer-online-identity"), { recursive: true });
    rmSync(join(root, "secrets"), { recursive: true });
    await expect(createIdentity(root, async () => false)).rejects.toThrow();
    await expect(
      createIdentity(root, async () => {
        throw new Error("unavailable");
      })
    ).rejects.toThrow();
    expect(await loadPeerOnlineIdentity(root)).toBeNull();
  });

  it("rejects unsafe ancestors before creating directories", async () => {
    const root = home();
    const target = join(root, "target");
    mkdirSync(target);
    symlinkSync(target, join(root, "link"));
    if (process.getuid?.() !== 0) {
      await expect(
        createPeerOnlineIdentity(join(root, "link", "new"))
      ).rejects.toThrow();
      expect(existsSync(join(target, "new"))).toBe(false);
    }
    const unsafe = join(root, "unsafe");
    mkdirSync(unsafe);
    chmodSync(unsafe, 0o777);
    await expect(
      createPeerOnlineIdentity(join(unsafe, "new"))
    ).rejects.toThrow();
    expect(existsSync(join(unsafe, "new"))).toBe(false);
  });

  it("rejects missing roots beneath sticky shared directories before mutation", async () => {
    const root = home();
    const shared = join(root, "shared");
    mkdirSync(shared);
    chmodSync(shared, 0o1777);
    const missing = join(shared, "missing");
    await expect(
      createPeerOnlineIdentity(join(missing, "home"))
    ).rejects.toThrow();
    expect(existsSync(missing)).toBe(false);
    await expect(
      loadPeerOnlineIdentity(join(missing, "home"))
    ).rejects.toThrow();
    expect(existsSync(missing)).toBe(false);
  });

  it("creates a missing root beneath an existing owner-private directory", async () => {
    const root = join(home(), "new", "home");
    const identity = await createPeerOnlineIdentity(root);
    expect((await loadPeerOnlineIdentity(root))?.publicIdentity).toEqual(
      identity.publicIdentity
    );
  });

  it("serializes concurrent creators in independent processes", async () => {
    const root = home();
    const vitest = fileURLToPath(
      new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url)
    );
    const child = () =>
      new Promise<{ code: number | null; output: string }>(
        (resolve, reject) => {
          const processChild = spawn(
            process.execPath,
            [
              vitest,
              "run",
              fileURLToPath(import.meta.url),
              "-t",
              "child creator"
            ],
            {
              env: { ...process.env, PEER_IDENTITY_TEST_CHILD: root },
              stdio: ["ignore", "pipe", "pipe"]
            }
          );
          let output = "";
          processChild.stdout.on("data", (chunk: Buffer) => {
            output += chunk.toString();
          });
          processChild.stderr.on("data", (chunk: Buffer) => {
            output += chunk.toString();
          });
          processChild.once("error", reject);
          processChild.once("close", (code) => resolve({ code, output }));
        }
      );
    const results = await Promise.all([child(), child()]);
    expect(results.filter((result) => result.code === 0)).toHaveLength(1);
    const losers = results.filter((result) => result.code !== 0);
    expect(losers).toHaveLength(1);
    expect(losers[0]?.output).toContain("Peer online identity already exists.");
    expect(await loadPeerOnlineIdentity(root)).not.toBeNull();
  }, 30000);

  it.skipIf(!process.env.PEER_IDENTITY_TEST_CHILD)(
    "child creator",
    async () => {
      await createPeerOnlineIdentity(process.env.PEER_IDENTITY_TEST_CHILD!);
    }
  );

  it("rejects unsafe storage permissions", async () => {
    const root = home();
    await createPeerOnlineIdentity(root);
    const { chmodSync } = await import("node:fs");
    chmodSync(join(root, "peer-online-identity"), 0o755);
    await expect(loadPeerOnlineIdentity(root)).rejects.toThrow();
  });
});
