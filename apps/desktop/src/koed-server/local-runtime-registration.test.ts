import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  localRuntimeRegistrationPath,
  readLocalRuntimeRegistration
} from "./local-runtime-registration.js";

const roots: string[] = [];

const tempHome = (): string => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-desktop-runtime-"));
  roots.push(root);
  return root;
};

const writeRegistration = (
  koedHome: string,
  overrides: Record<string, unknown> = {}
): string => {
  const registrationPath = localRuntimeRegistrationPath(koedHome);
  mkdirSync(resolve(koedHome, "run"), { recursive: true, mode: 0o700 });
  writeFileSync(
    registrationPath,
    JSON.stringify({
      protocolVersion: 1,
      url: "http://127.0.0.1:43123",
      authorization: `Bearer ${"a".repeat(43)}`,
      pid: 1234,
      startedAt: "2026-08-19T16:51:41.000Z",
      ...overrides
    }),
    { mode: 0o600 }
  );
  return registrationPath;
};

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Desktop local AI runtime registration", () => {
  it("reads owner-only authenticated loopback registrations", () => {
    const koedHome = tempHome();
    writeRegistration(koedHome);

    expect(readLocalRuntimeRegistration(koedHome)).toMatchObject({
      protocolVersion: 1,
      url: "http://127.0.0.1:43123",
      authorization: expect.stringMatching(/^Bearer /)
    });
  });

  it("rejects unsafe runtime URLs and credentials", () => {
    for (const url of [
      "https://127.0.0.1:43123",
      "http://example.test:43123",
      "http://user:pass@127.0.0.1:43123",
      "http://127.0.0.1:43123/?redirect=example.test",
      "http://127.0.0.1:0"
    ]) {
      const koedHome = tempHome();
      writeRegistration(koedHome, { url });
      expect(() => readLocalRuntimeRegistration(koedHome)).toThrow(
        "registration is invalid"
      );
    }
  });

  it("rejects native Windows Desktop registration reads", () => {
    const platform = process.platform;
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      expect(() => readLocalRuntimeRegistration(tempHome())).toThrow(
        "Native Windows Desktop local AI runtime registration is unsupported"
      );
    } finally {
      vi.restoreAllMocks();
      expect(process.platform).toBe(platform);
    }
  });

  it.runIf(process.platform !== "win32")(
    "rejects symlinked or group-readable registrations",
    () => {
      const symlinkHome = tempHome();
      const target = writeRegistration(symlinkHome);
      const replacement = `${target}.replacement`;
      writeFileSync(replacement, "{}", { mode: 0o600 });
      rmSync(target);
      symlinkSync(replacement, target);
      expect(() => readLocalRuntimeRegistration(symlinkHome)).toThrow(
        "registration is unavailable"
      );

      const modeHome = tempHome();
      const modePath = writeRegistration(modeHome);
      chmodSync(modePath, 0o640);
      expect(() => readLocalRuntimeRegistration(modeHome)).toThrow(
        "registration is invalid"
      );
    }
  );
});
