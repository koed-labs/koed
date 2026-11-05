import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  unlinkSync
} from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runKoedServerCli } from "./cli.js";
import { createPeerOnlineIdentity } from "./peer-online-identity.js";
import { createPeerOnlineCertificateStore } from "./peer-online-certificate-store.js";
import { createPeerOnlineCertificate } from "./peer-online-certificate.js";

const output = () => {
  let text = "";
  return {
    stream: {
      write: (chunk: unknown) => {
        text += String(chunk);
        return true;
      }
    },
    text: () => text
  };
};

describe("peer-online CLI", () => {
  it("reports disabled status without creating a missing home", async () => {
    const root = resolve("scratch", "peer-online-cli-missing-home");
    rmSync(root, { recursive: true, force: true });
    const stdout = output();
    const code = await runKoedServerCli(["peer-online", "status", "--json"], {
      stdout: stdout.stream,
      resolvePaths: () => ({ koedHome: root }) as never
    });
    expect(code).toBe(0);
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: true,
      enabled: false,
      identity: "missing",
      certificate: "missing"
    });
    expect(existsSync(root)).toBe(false);
  });

  it("reads existing local identity without reporting sync enabled or exposing keys", async () => {
    mkdirSync("scratch", { recursive: true });
    const root = mkdtempSync(resolve("scratch", "peer-online-cli-"));
    try {
      const identity = await createPeerOnlineIdentity(root, async () => true);
      const before = statSync(root).mtimeMs;
      const stdout = output();
      const code = await runKoedServerCli(["peer-online", "status", "--json"], {
        stdout: stdout.stream,
        resolvePaths: () => ({ koedHome: root }) as never
      });
      expect(code).toBe(0);
      expect(JSON.parse(stdout.text())).toMatchObject({
        ok: true,
        enabled: false,
        identity: "present",
        certificate: "missing",
        deviceId: identity.publicIdentity.deviceId
      });
      expect(stdout.text()).not.toContain(
        identity.getRuntimeKeys().signingPrivateKey
      );
      expect(stdout.text()).not.toContain(
        identity.getRuntimeKeys().encryptionPrivateKey
      );
      expect(statSync(root).mtimeMs).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports validated certificate custody without exposing private keys", async () => {
    mkdirSync("scratch", { recursive: true });
    const root = mkdtempSync(resolve("scratch", "peer-online-cli-cert-"));
    try {
      const cert = await createPeerOnlineCertificate(
        createPeerOnlineCertificateStore(root),
        async () => true
      );
      const before = statSync(resolve(root, "peer-online-certificate")).mtimeMs;
      const stdout = output();
      expect(
        await runKoedServerCli(["peer-online", "status", "--json"], {
          stdout: stdout.stream,
          resolvePaths: () => ({ koedHome: root }) as never
        })
      ).toBe(0);
      expect(statSync(resolve(root, "peer-online-certificate")).mtimeMs).toBe(
        before
      );
      expect(JSON.parse(stdout.text())).toMatchObject({
        enabled: false,
        identity: "missing",
        certificate: "present"
      });
      expect(stdout.text()).not.toContain(cert.privateKey);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when identity custody is incomplete", async () => {
    mkdirSync("scratch", { recursive: true });
    const root = mkdtempSync(resolve("scratch", "peer-online-cli-corrupt-"));
    try {
      await createPeerOnlineIdentity(root, async () => true);
      unlinkSync(resolve(root, "secrets", "peer-online-identity.key"));
      const stdout = output();
      expect(
        await runKoedServerCli(["peer-online", "status", "--json"], {
          stdout: stdout.stream,
          resolvePaths: () => ({ koedHome: root }) as never
        })
      ).toBe(1);
      expect(JSON.parse(stdout.text())).toMatchObject({ ok: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports busy rather than missing while identity initialization holds the lock", async () => {
    mkdirSync("scratch", { recursive: true });
    const root = mkdtempSync(resolve("scratch", "peer-online-cli-busy-"));
    try {
      mkdirSync(resolve(root, "peer-online-identity-init.lock"));
      const stdout = output();
      expect(
        await runKoedServerCli(["peer-online", "status", "--json"], {
          stdout: stdout.stream,
          resolvePaths: () => ({ koedHome: root }) as never
        })
      ).toBe(1);
      expect(stdout.text()).not.toContain('"identity": "missing"');
      expect(JSON.parse(stdout.text())).toMatchObject({ ok: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not change existing empty home when inspecting status", async () => {
    mkdirSync("scratch", { recursive: true });
    const root = mkdtempSync(resolve("scratch", "peer-online-cli-readonly-"));
    try {
      const before = statSync(root).mtimeMs;
      const stdout = output();
      expect(
        await runKoedServerCli(["peer-online", "status", "--json"], {
          stdout: stdout.stream,
          resolvePaths: () => ({ koedHome: root }) as never
        })
      ).toBe(0);
      expect(existsSync(resolve(root, "secrets"))).toBe(false);
      expect(statSync(root).mtimeMs).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects orphan identity key without revealing its value", async () => {
    mkdirSync("scratch", { recursive: true });
    const root = mkdtempSync(resolve("scratch", "peer-online-cli-orphan-"));
    try {
      const identity = await createPeerOnlineIdentity(root, async () => true);
      rmSync(resolve(root, "peer-online-identity"), { recursive: true });
      unlinkSync(resolve(root, "secrets", "peer-online-identity.json"));
      const stdout = output();
      const stderr = output();
      expect(
        await runKoedServerCli(["peer-online", "status", "--json"], {
          stdout: stdout.stream,
          stderr: stderr.stream,
          resolvePaths: () => ({ koedHome: root }) as never
        })
      ).toBe(1);
      expect(JSON.parse(stdout.text())).toMatchObject({ ok: false });
      expect(stdout.text() + stderr.text()).not.toContain(
        identity.getRuntimeKeys().signingPrivateKey
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sanitizes errors in JSON and human output", async () => {
    for (const json of [false, true]) {
      const stdout = output();
      const stderr = output();
      const secret = "private-error-detail";
      expect(
        await runKoedServerCli(
          ["peer-online", "status", ...(json ? ["--json"] : [])],
          {
            stdout: stdout.stream,
            stderr: stderr.stream,
            resolvePaths: () => {
              throw new Error(secret);
            }
          }
        )
      ).toBe(1);
      expect(stdout.text() + stderr.text()).not.toContain(secret);
      expect(
        json ? (JSON.parse(stdout.text()) as { ok: unknown }).ok : stderr.text()
      ).toBe(
        json
          ? false
          : "Unable to inspect peer-online custody; storage may be inaccessible or corrupt.\n"
      );
    }
  });

  it("rejects unfinished certificate custody", async () => {
    mkdirSync("scratch", { recursive: true });
    const root = mkdtempSync(resolve("scratch", "peer-online-cli-pending-"));
    try {
      mkdirSync(resolve(root, "peer-online-certificate"), { mode: 0o700 });
      mkdirSync(resolve(root, "peer-online-certificate", "pending"), {
        mode: 0o700
      });
      const stdout = output();
      expect(
        await runKoedServerCli(["peer-online", "status", "--json"], {
          stdout: stdout.stream,
          resolvePaths: () => ({ koedHome: root }) as never
        })
      ).toBe(1);
      expect(JSON.parse(stdout.text())).toMatchObject({ ok: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects unsupported platforms even when home is missing", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const stdout = output();
    try {
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true
      });
      expect(
        await runKoedServerCli(["peer-online", "status", "--json"], {
          stdout: stdout.stream,
          resolvePaths: () =>
            ({
              koedHome: resolve("scratch", "peer-online-cli-missing-platform")
            }) as never
        })
      ).toBe(1);
      expect(JSON.parse(stdout.text())).toMatchObject({
        ok: false,
        error: expect.stringContaining("unsupported") as unknown
      });
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  it("does not offer unsafe initialization", async () => {
    const stdout = output();
    expect(
      await runKoedServerCli(["peer-online", "init", "--json"], {
        stdout: stdout.stream
      })
    ).toBe(2);
    expect(JSON.parse(stdout.text())).toMatchObject({ ok: false });
  });
});
