import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertCleanRemoteMcpEnrollment,
  hasRemoteMcpLocalRuntimeScopes,
  normalizeRemoteMcpBackend,
  readRemoteMcpCredential,
  remoteMcpCredentialPath,
  withRemoteMcpCredentialLock,
  writeRemoteMcpCredential,
  type RemoteMcpCredential
} from "./remote-mcp-credentials.js";

const roots: string[] = [];
const fixture = () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-remote-custody-"));
  roots.push(root);
  return { root, environment: { KOED_HOME: resolve(root, "koed") } };
};
const credential: RemoteMcpCredential = {
  version: 1,
  backendUrl: "https://koed.example.test",
  resourceUrl: "https://koed.example.test/mcp",
  issuerUrl: "https://koed.example.test",
  userId: "user-1",
  clientId: "public-client-1",
  tokens: {
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    expiresAt: 5_000_000,
    scope: "koed:memory:read koed:capture koed:local-execution"
  }
};

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

it("uses the same protected lock across processes", async () => {
  const { environment } = fixture();
  const lockModule = createRequire(import.meta.url).resolve("proper-lockfile");
  await withRemoteMcpCredentialLock(environment, async () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
        const lock = require(${JSON.stringify(lockModule)});
        lock.lock(${JSON.stringify(remoteMcpCredentialPath(environment))}, {realpath:false,retries:0})
          .then(async release => { await release(); process.exit(2); })
          .catch(error => process.exit(error.code === 'ELOCKED' ? 0 : 3));
      `
      ],
      { stdio: "ignore" }
    );
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    expect(exitCode).toBe(0);
  });
  expect(existsSync(`${remoteMcpCredentialPath(environment)}.lock`)).toBe(
    false
  );
});

describe("remote MCP credential custody", () => {
  it("stores credentials atomically with private permissions and fixed binding", () => {
    const { environment } = fixture();
    expect(readRemoteMcpCredential(environment)).toBeNull();
    writeRemoteMcpCredential(environment, credential);
    expect(readRemoteMcpCredential(environment)).toEqual(credential);
    expect(statSync(remoteMcpCredentialPath(environment)).mode & 0o777).toBe(
      0o600
    );
    expect(hasRemoteMcpLocalRuntimeScopes(credential)).toBe(true);
    expect(
      hasRemoteMcpLocalRuntimeScopes({
        ...credential,
        tokens: { ...credential.tokens!, scope: "koed:memory:read" }
      })
    ).toBe(false);
    expect(() =>
      writeRemoteMcpCredential(environment, {
        ...credential,
        userId: "another-user"
      })
    ).toThrow();
    expect(() =>
      writeRemoteMcpCredential(environment, {
        ...credential,
        backendUrl: "https://another.example.test",
        resourceUrl: "https://another.example.test/mcp",
        issuerUrl: "https://another.example.test"
      })
    ).toThrow();
    expect(readRemoteMcpCredential(environment)).toEqual(credential);
  });

  it("rejects unsafe endpoints, symlinks, public credentials, and existing personal state", () => {
    const { root, environment } = fixture();
    for (const url of [
      "http://koed.example.test",
      "https://secret@koed.example.test",
      "https://koed.example.test?token=secret",
      "https://koed.example.test/other",
      "https://koed.example.test/mcp#token"
    ]) {
      expect(() => normalizeRemoteMcpBackend(url)).toThrow();
    }
    expect(normalizeRemoteMcpBackend("https://koed.example.test/mcp")).toBe(
      credential.backendUrl
    );
    mkdirSync(resolve(environment.KOED_HOME, "config"), {
      recursive: true,
      mode: 0o700
    });
    const external = resolve(root, "external");
    writeFileSync(external, "untouched", { mode: 0o600 });
    symlinkSync(external, remoteMcpCredentialPath(environment));
    expect(() => writeRemoteMcpCredential(environment, credential)).toThrow();
    expect(readFileSync(external, "utf8")).toBe("untouched");
    rmSync(remoteMcpCredentialPath(environment));
    writeRemoteMcpCredential(environment, credential);
    chmodSync(remoteMcpCredentialPath(environment), 0o644);
    expect(() => readRemoteMcpCredential(environment)).toThrow();
    chmodSync(remoteMcpCredentialPath(environment), 0o600);
    rmSync(remoteMcpCredentialPath(environment));
    writeFileSync(
      resolve(environment.KOED_HOME, "config/local-app-credential.json"),
      "personal-state"
    );
    expect(() => assertCleanRemoteMcpEnrollment(environment)).toThrow(
      "dedicated"
    );
  });

  it("serializes concurrent credential transactions and releases the lock", async () => {
    const { environment } = fixture();
    const order: number[] = [];
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withRemoteMcpCredentialLock(environment, async () => {
      order.push(1);
      await wait;
      order.push(2);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = withRemoteMcpCredentialLock(environment, async () => {
      order.push(3);
    });
    release();
    await Promise.all([first, second]);
    expect(order).toEqual([1, 2, 3]);
    expect(existsSync(`${remoteMcpCredentialPath(environment)}.lock`)).toBe(
      false
    );
  });
});
