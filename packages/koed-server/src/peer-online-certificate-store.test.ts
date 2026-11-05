import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createPeerOnlineCertificateStore } from "./peer-online-certificate-store.js";
import {
  createPeerOnlineCertificate,
  loadPeerOnlineCertificate
} from "./peer-online-certificate.js";

const homes: string[] = [];
function home(): string {
  const root = mkdtempSync(join(tmpdir(), "koed-cert-store-"));
  homes.push(root);
  return root;
}
afterEach(() => {
  for (const root of homes.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("peer online certificate store", () => {
  it("persists encrypted certificate custody and never replaces it", async () => {
    const root = home();
    const store = createPeerOnlineCertificateStore(root);
    expect(await store.read()).toBeNull();
    const cert = await createPeerOnlineCertificate(store, async () => true);
    expect(
      (await loadPeerOnlineCertificate(createPeerOnlineCertificateStore(root)))
        .spkiPin
    ).toBe(cert.spkiPin);
    expect(await store.create("replacement")).toBe(false);
    const dir = join(root, "peer-online-certificate");
    const disk = readdirSync(join(dir, "secrets"))
      .map((name) => readFileSync(join(dir, "secrets", name)).toString())
      .join("");
    expect(disk).not.toContain(cert.privateKey);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const name of readdirSync(join(dir, "secrets")))
      expect(statSync(join(dir, "secrets", name)).mode & 0o077).toBe(0);
  });

  it("returns the same certificate to competing creators", async () => {
    const root = home();
    const certificates = await Promise.all(
      Array.from({ length: 4 }, () =>
        createPeerOnlineCertificate(
          createPeerOnlineCertificateStore(root),
          async () => true
        )
      )
    );
    expect(
      new Set(certificates.map((certificate) => certificate.spkiPin)).size
    ).toBe(1);
  });

  it.each(["peer-online-certificate.json", "peer-online-certificate.key"])(
    "fails closed after loss of %s",
    async (name) => {
      const root = home();
      const store = createPeerOnlineCertificateStore(root);
      await store.create("secret");
      unlinkSync(join(root, "peer-online-certificate", "secrets", name));
      await expect(store.read()).rejects.toThrow();
      await expect(store.create("replacement")).rejects.toThrow();
    }
  );

  it("fails closed on corrupt ciphertext and incomplete custody", async () => {
    const root = home();
    const store = createPeerOnlineCertificateStore(root);
    await store.create("secret");
    writeFileSync(
      join(
        root,
        "peer-online-certificate",
        "secrets",
        "peer-online-certificate.json"
      ),
      "bad"
    );
    await expect(store.read()).rejects.toThrow();
    await expect(store.create("replacement")).rejects.toThrow();
  });

  it("does not regenerate after a partial initialization", async () => {
    const root = home();
    mkdirSync(join(root, "peer-online-certificate"), { mode: 0o700 });
    const store = createPeerOnlineCertificateStore(root);
    await expect(store.read()).rejects.toThrow();
    await expect(store.create("replacement")).rejects.toThrow();
  }, 10000);

  it("requires independent authorization after complete local loss", async () => {
    const root = home();
    const store = createPeerOnlineCertificateStore(root);
    await createPeerOnlineCertificate(store, async () => true);
    rmSync(join(root, "peer-online-certificate"), { recursive: true });
    await expect(loadPeerOnlineCertificate(store)).rejects.toThrow();
    await expect(
      createPeerOnlineCertificate(store, async () => false)
    ).rejects.toThrow();
    expect(await store.read()).toBeNull();
  });

  it.each([
    "committed",
    "secrets/peer-online-certificate.json",
    "secrets/peer-online-certificate.key"
  ])("rejects hardlinked custody file %s", async (name) => {
    const root = home();
    const store = createPeerOnlineCertificateStore(root);
    await store.create("secret");
    linkSync(join(root, "peer-online-certificate", name), join(root, "alias"));
    await expect(store.read()).rejects.toThrow();
    await expect(store.create("replacement")).rejects.toThrow();
  });

  it("prevalidates oversized values without claiming custody", async () => {
    const root = home();
    const store = createPeerOnlineCertificateStore(root);
    await expect(store.create("x".repeat(2_000_001))).rejects.toThrow();
    expect(await store.read()).toBeNull();
    expect(await store.create("valid")).toBe(true);
  });

  it("blocks readers and competing creators until durable publication", async () => {
    const root = home();
    let resume!: () => void;
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const writer = createPeerOnlineCertificateStore(root, {
      afterMarkerCreated: async () => {
        entered();
        await gate;
      }
    });
    const writing = writer.create("winner");
    await reached;
    let finished = false;
    const reading = createPeerOnlineCertificateStore(root)
      .read()
      .then((value) => {
        finished = true;
        return value;
      });
    const competing = createPeerOnlineCertificateStore(root).create("loser");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(finished).toBe(false);
    resume();
    expect(await writing).toBe(true);
    expect(await reading).toBe("winner");
    expect(await competing).toBe(false);
  });

  it("leaves incomplete custody after a commit failure", async () => {
    const root = home();
    const store = createPeerOnlineCertificateStore(root, {
      afterMarkerCreated: async () => {
        throw new Error("injected");
      }
    });
    await expect(store.create("secret")).rejects.toThrow("injected");
    await expect(
      createPeerOnlineCertificateStore(root).read()
    ).rejects.toThrow();
    await expect(
      createPeerOnlineCertificateStore(root).create("replacement")
    ).rejects.toThrow();
  }, 10000);

  it.each(["EINVAL", "ENOTSUP", "EACCES"])(
    "preserves incomplete custody when secrets directory sync fails with %s",
    async (code) => {
      const root = home();
      const directory = join(root, "peer-online-certificate");
      const store = createPeerOnlineCertificateStore(root, {
        beforeDirectorySync: (path) => {
          if (path === join(directory, "secrets"))
            throw Object.assign(new Error("injected directory sync failure"), {
              code
            });
        }
      });
      await expect(store.create("secret")).rejects.toThrow(
        "injected directory sync failure"
      );
      expect(existsSync(join(directory, "pending"))).toBe(true);
      expect(
        existsSync(join(directory, "secrets", "peer-online-certificate.key"))
      ).toBe(true);
      expect(
        existsSync(join(directory, "secrets", "peer-online-certificate.json"))
      ).toBe(true);
      const restarted = createPeerOnlineCertificateStore(root);
      await expect(restarted.read()).rejects.toThrow();
      await expect(restarted.create("replacement")).rejects.toThrow();
      expect(existsSync(join(directory, "pending"))).toBe(true);
    },
    10000
  );

  it("permits verified reload after an ambiguous final sync failure", async () => {
    const root = home();
    const directory = join(root, "peer-online-certificate");
    let syncs = 0;
    const store = createPeerOnlineCertificateStore(root, {
      beforeDirectorySync: (path) => {
        if (path === directory && ++syncs === 3)
          throw new Error("final sync failed");
      }
    });
    await expect(store.create("secret")).rejects.toThrow("final sync failed");
    expect(await createPeerOnlineCertificateStore(root).read()).toBe("secret");
    expect(
      await createPeerOnlineCertificateStore(root).create("replacement")
    ).toBe(false);
  });

  it("syncs new-root ancestry and surfaces sync failures without claiming custody", async () => {
    const root = join(home(), "new", "home");
    const synced: string[] = [];
    const store = createPeerOnlineCertificateStore(root, {
      beforeDirectorySync: (path) => {
        synced.push(path);
        if (path === root) throw new Error("sync failure");
      }
    });
    await expect(store.create("secret")).rejects.toThrow("sync failure");
    expect(synced).toContain(join(root, ".."));
    expect(synced).toContain(join(root, "..", ".."));
    await expect(
      createPeerOnlineCertificateStore(root).read()
    ).rejects.toThrow();
  });

  it("rejects unsafe ancestry and permissions", async () => {
    const root = home();
    const unsafe = join(root, "unsafe");
    mkdirSync(unsafe, { mode: 0o777 });
    chmodSync(unsafe, 0o777);
    await expect(
      createPeerOnlineCertificateStore(join(unsafe, "new")).read()
    ).rejects.toThrow();
    expect(existsSync(join(unsafe, "new"))).toBe(false);
    const store = createPeerOnlineCertificateStore(root);
    await store.create("secret");
    chmodSync(join(root, "peer-online-certificate"), 0o755);
    await expect(store.read()).rejects.toThrow();
  });

  it("commits exactly one value across independent processes", async () => {
    const root = home();
    const vitest = fileURLToPath(
      new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url)
    );
    const child = (value: string) =>
      new Promise<{ code: number | null; output: string }>(
        (resolve, reject) => {
          const p = spawn(
            process.execPath,
            [
              vitest,
              "run",
              fileURLToPath(import.meta.url),
              "-t",
              "child writer"
            ],
            {
              env: {
                ...process.env,
                CERT_STORE_CHILD: root,
                CERT_STORE_VALUE: value
              },
              stdio: ["ignore", "pipe", "pipe"]
            }
          );
          let output = "";
          p.stdout.on("data", (chunk: Buffer) => {
            output += chunk;
          });
          p.stderr.on("data", (chunk: Buffer) => {
            output += chunk;
          });
          p.once("error", reject);
          p.once("close", (code) => resolve({ code, output }));
        }
      );
    const children = [child("first"), child("second")];
    for (
      let i = 0;
      i < 500 &&
      (!existsSync(join(root, "ready-first")) ||
        !existsSync(join(root, "ready-second")));
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(existsSync(join(root, "ready-first"))).toBe(true);
    expect(existsSync(join(root, "ready-second"))).toBe(true);
    writeFileSync(join(root, "go"), "");
    const results = await Promise.all(children);
    expect(results.map((r) => r.code)).toEqual([0, 0]);
    expect(
      ["first", "second"]
        .map((value) => readFileSync(join(root, `result-${value}`), "utf8"))
        .sort()
    ).toEqual(["false", "true"]);
    expect(["first", "second"]).toContain(
      await createPeerOnlineCertificateStore(root).read()
    );
  }, 30000);

  it.skipIf(!process.env.CERT_STORE_CHILD)("child writer", async () => {
    const root = process.env.CERT_STORE_CHILD!;
    writeFileSync(join(root, `ready-${process.env.CERT_STORE_VALUE!}`), "");
    for (let i = 0; !existsSync(join(root, "go")); i++) {
      if (i >= 1000) throw new Error("barrier timeout");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const created = await createPeerOnlineCertificateStore(
      process.env.CERT_STORE_CHILD!
    ).create(process.env.CERT_STORE_VALUE!);
    writeFileSync(
      join(
        process.env.CERT_STORE_CHILD!,
        `result-${process.env.CERT_STORE_VALUE!}`
      ),
      String(created)
    );
  });
});
