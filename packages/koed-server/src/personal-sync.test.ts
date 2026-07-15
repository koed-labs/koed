import {
  chmodSync,
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
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

afterEach(() => {
  for (const directory of roots.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const passwordFd = (
  directory: string,
  password = "correct horse battery staple"
) => {
  const path = resolve(directory, "password");
  writeFileSync(path, `${password}\n`, { mode: 0o600 });
  return openSync(path, "r");
};

const secretProvider = () => {
  const values = new Map<string, string>();
  return {
    values,
    spawnSync: ((
      _command: string,
      args: string[],
      options: { input?: string }
    ) => {
      const [operation, reference] = args;
      if (operation === "put" && options.input) {
        values.set(reference!, options.input);
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: values.get(reference!) ?? "", stderr: "" };
    }) as never
  };
};

const pathsFor = (directory: string) =>
  ({
    configDir: resolve(directory, "config")
  }) as never;

const env = {
  PDS_SECRET_PROVIDER: "headless",
  PDS_SECRET_PROVIDER_COMMAND: "/usr/local/bin/operator-secret"
};

describe("Personal Sync recovery kit", () => {
  it("uses versioned scrypt and AES-GCM format", () => {
    const password = Buffer.from("correct horse battery staple");
    const kit = encryptRecoveryKit('{"groupId":"pds_test"}', password);
    expect(kit).toMatchObject({
      format: "koed/pds-recovery-kit/v1",
      version: 1,
      kdf: { name: "scrypt", N: 32768, r: 8, p: 1 },
      cipher: { name: "aes-256-gcm" }
    });
    expect(decryptRecoveryKit(kit, password)).toBe('{"groupId":"pds_test"}');
    expect(() => decryptRecoveryKit(kit, Buffer.from("wrong"))).toThrow(
      "Recovery kit password or authentication tag is invalid."
    );
  });

  it("requires recovery verification before future-only enable and redacts status", async () => {
    const directory = root();
    const provider = secretProvider();
    const fd = passwordFd(directory);
    const recoveryKit = resolve(directory, "recovery-kit.json");
    try {
      const bootstrapped = await runPersonalSyncCommand(
        [
          "group",
          "bootstrap",
          "--secret-ref",
          "operator://pds/one",
          "--recovery-kit",
          recoveryKit,
          "--password-fd",
          String(fd)
        ],
        pathsFor(directory),
        env,
        { spawnSync: provider.spawnSync }
      );
      expect(bootstrapped.state).toBe("recovery_verification_required");
      expect(readFileSync(recoveryKit, "utf8")).not.toContain(
        "deviceSigningSeed"
      );
      expect(readFileSync(recoveryKit, "utf8")).not.toContain("correct horse");
      await expect(
        runPersonalSyncCommand(["policy", "enable"], pathsFor(directory), env, {
          spawnSync: provider.spawnSync
        })
      ).rejects.toThrow("Recovery kit verification and finalized genesis");
    } finally {
      closeSync(fd);
    }

    const verificationFd = passwordFd(directory);
    try {
      const verified = await runPersonalSyncCommand(
        [
          "recovery-kit",
          "verify",
          "--recovery-kit",
          recoveryKit,
          "--password-fd",
          String(verificationFd)
        ],
        pathsFor(directory),
        env,
        { spawnSync: provider.spawnSync }
      );
      expect(verified).toMatchObject({
        state: "verified",
        genesis: { state: "finalized" }
      });
    } finally {
      closeSync(verificationFd);
    }
    const enabled = await runPersonalSyncCommand(
      ["policy", "enable"],
      pathsFor(directory),
      env,
      { spawnSync: provider.spawnSync }
    );
    expect(enabled.message).toContain("future closed Sessions only");
    expect(statSync(recoveryKit).mode & 0o777).toBe(0o600);
    const status = await runPersonalSyncCommand(
      ["status"],
      pathsFor(directory),
      env,
      { spawnSync: provider.spawnSync }
    );
    expect(JSON.stringify(status)).not.toContain("deviceSigningSeed");
    expect(JSON.stringify(status)).not.toContain("sourceFingerprintKey");
    expect(JSON.stringify(status)).not.toContain("operator://pds/one");
  });

  it("rejects password arguments", async () => {
    await expect(
      runPersonalSyncCommand(
        ["status", "--password", "leak"],
        pathsFor(root()),
        env
      )
    ).rejects.toThrow("password arguments are forbidden");
  });

  it("fails closed for unsupported providers and unsafe kit permissions", async () => {
    const directory = root();
    const recoveryKit = resolve(directory, "recovery-kit.json");
    const fd = passwordFd(directory);
    try {
      await expect(
        runPersonalSyncCommand(
          [
            "group",
            "bootstrap",
            "--secret-ref",
            "operator://pds/unavailable",
            "--recovery-kit",
            recoveryKit,
            "--password-fd",
            String(fd)
          ],
          pathsFor(directory),
          { PDS_SECRET_PROVIDER: "desktop" }
        )
      ).rejects.toThrow("Desktop secure runtime");
    } finally {
      closeSync(fd);
    }

    const provider = secretProvider();
    const setupFd = passwordFd(directory);
    try {
      await runPersonalSyncCommand(
        [
          "group",
          "bootstrap",
          "--secret-ref",
          "operator://pds/permissions",
          "--recovery-kit",
          recoveryKit,
          "--password-fd",
          String(setupFd)
        ],
        pathsFor(directory),
        env,
        { spawnSync: provider.spawnSync }
      );
    } finally {
      closeSync(setupFd);
    }
    chmodSync(recoveryKit, 0o644);
    const verifyFd = passwordFd(directory);
    try {
      await expect(
        runPersonalSyncCommand(
          [
            "recovery-kit",
            "verify",
            "--recovery-kit",
            recoveryKit,
            "--password-fd",
            String(verifyFd)
          ],
          pathsFor(directory),
          env,
          { spawnSync: provider.spawnSync }
        )
      ).rejects.toThrow("permissions are unsafe");
    } finally {
      closeSync(verifyFd);
    }
  });

  it("requires recovery-kit password for recovery approval and reports lifecycle", async () => {
    const directory = root();
    const provider = secretProvider();
    const recoveryKit = resolve(directory, "recovery-kit.json");
    const bootstrapFd = passwordFd(directory);
    try {
      await runPersonalSyncCommand(
        [
          "group",
          "bootstrap",
          "--secret-ref",
          "operator://pds/lifecycle",
          "--recovery-kit",
          recoveryKit,
          "--password-fd",
          String(bootstrapFd)
        ],
        pathsFor(directory),
        env,
        { spawnSync: provider.spawnSync }
      );
    } finally {
      closeSync(bootstrapFd);
    }
    const request = await runPersonalSyncCommand(
      ["join", "request"],
      pathsFor(directory),
      env,
      { spawnSync: provider.spawnSync }
    );
    const requestId = (request.request as { id: string }).id;
    await expect(
      runPersonalSyncCommand(
        [
          "recovery",
          "approve",
          "--request-id",
          requestId,
          "--device-id",
          "device_replacement"
        ],
        pathsFor(directory),
        env,
        { spawnSync: provider.spawnSync }
      )
    ).rejects.toThrow("Use exactly one of --password-stdin or --password-fd");

    const approvalFd = passwordFd(directory);
    try {
      await expect(
        runPersonalSyncCommand(
          [
            "recovery",
            "approve",
            "--request-id",
            requestId,
            "--device-id",
            "device_replacement",
            "--recovery-kit",
            recoveryKit,
            "--password-fd",
            String(approvalFd)
          ],
          pathsFor(directory),
          env,
          { spawnSync: provider.spawnSync }
        )
      ).resolves.toMatchObject({ state: "approved", epoch: "2" });
    } finally {
      closeSync(approvalFd);
    }
    const revoked = await runPersonalSyncCommand(
      ["device", "revoke", "--device-id", "device_replacement"],
      pathsFor(directory),
      env,
      { spawnSync: provider.spawnSync }
    );
    expect(revoked.message).toContain(
      "cannot erase plaintext already downloaded"
    );
    const status = await runPersonalSyncCommand(
      ["status"],
      pathsFor(directory),
      env,
      { spawnSync: provider.spawnSync }
    );
    expect(status).toMatchObject({
      group: { genesis: { state: "finalized" } },
      devices: [
        { state: "active" },
        { id: "device_replacement", state: "revoked" }
      ]
    });
  });
});
