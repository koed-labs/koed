import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
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
      ).rejects.toThrow("Recovery kit verification is required");
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
      expect(verified.state).toBe("verified");
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
});
