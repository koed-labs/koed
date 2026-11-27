import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  readFileSync
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as shared from "@koed-labs/shared";
import {
  rotateDesktopLocalCredential,
  storeDesktopLocalCredential
} from "@koed-labs/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recheckOwnerBinding, resolveOwnerBinding } from "./owner-binding.js";

const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherUserId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const homes: string[] = [];

function setup(family = "personal_collaboration_write") {
  const scratch = fileURLToPath(
    new URL("../../../../scratch/", import.meta.url)
  );
  mkdirSync(scratch, { recursive: true });
  const koedHome = mkdtempSync(resolve(scratch, "owner-binding-"));
  homes.push(koedHome);
  const credential = storeDesktopLocalCredential(koedHome, {
    ownerUserId: userId,
    operationFamilies: [family]
  });
  const options = {
    koedHome,
    deploymentProfile: "local_personal",
    resolveActiveLocalUser: async (id: string) => ({ id }),
    reportOperationalFailure: (_category: "custody" | "user_lookup") => {}
  };
  return { koedHome, credential, options };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

describe("Desktop owner binding", () => {
  it("derives a frozen owner binding without returning credential material", async () => {
    const { credential, options } = setup();
    const binding = await resolveOwnerBinding(options);
    expect(binding).toEqual({
      owner: `desktop:${credential.credentialKeyId}`,
      ownerUserId: userId,
      credentialKeyId: credential.credentialKeyId
    });
    expect(Object.isFrozen(binding)).toBe(true);
    expect(JSON.stringify(binding)).not.toContain(credential.authorization);
    expect(JSON.stringify(binding)).not.toContain(
      credential.authorization.split(":")[1]
    );
    expect(await recheckOwnerBinding(options, binding!)).toBe(true);
  });

  it("rejects wrong profile, family, missing user, and mismatched user", async () => {
    const { options } = setup();
    expect(
      await resolveOwnerBinding({ ...options, deploymentProfile: "team" })
    ).toBeNull();
    expect(
      await resolveOwnerBinding({
        ...options,
        resolveActiveLocalUser: async () => null
      })
    ).toBeNull();
    expect(
      await resolveOwnerBinding({
        ...options,
        resolveActiveLocalUser: async () => ({ id: otherUserId })
      })
    ).toBeNull();
    expect(
      await resolveOwnerBinding(setup("personal_collaboration_read").options)
    ).toBeNull();
  });

  it("fails closed on unavailable custody or user lookup", async () => {
    const { koedHome, options } = setup();
    expect(
      await resolveOwnerBinding({
        ...options,
        resolveActiveLocalUser: async () => {
          throw new Error("unavailable");
        }
      })
    ).toBeNull();
    unlinkSync(resolve(koedHome, "config", "local-secret-store.key"));
    expect(await resolveOwnerBinding(options)).toBeNull();
  });

  it("rejects a stale binding after credential rotation or user disablement", async () => {
    const { koedHome, options } = setup();
    const binding = (await resolveOwnerBinding(options))!;
    expect(
      await recheckOwnerBinding(
        { ...options, resolveActiveLocalUser: async () => null },
        binding
      )
    ).toBe(false);
    rotateDesktopLocalCredential(koedHome);
    expect(await recheckOwnerBinding(options, binding)).toBe(false);
    const replacement = await resolveOwnerBinding(options);
    expect(replacement?.credentialKeyId).not.toBe(binding.credentialKeyId);
  });

  it("reports sanitized operational failures without leaking exceptions", async () => {
    const { options, credential } = setup();
    const report = vi.fn();
    const failing = {
      ...options,
      reportOperationalFailure: report,
      resolveActiveLocalUser: async () => {
        throw new Error(credential.authorization);
      }
    };
    expect(await resolveOwnerBinding(failing)).toBeNull();
    expect(report.mock.calls).toEqual([["user_lookup"]]);
    expect(JSON.stringify(report.mock.calls)).not.toContain(
      credential.authorization
    );
    vi.spyOn(
      shared,
      "readDesktopLocalCredentialAuthorization"
    ).mockImplementation(() => {
      throw new Error(credential.authorization);
    });
    expect(await resolveOwnerBinding(failing)).toBeNull();
    expect(report.mock.calls[1]).toEqual(["custody"]);
  });

  it("rejects rotation between custody read and verification", async () => {
    const { koedHome, options } = setup();
    const actual = shared.readDesktopLocalCredentialAuthorization;
    vi.spyOn(
      shared,
      "readDesktopLocalCredentialAuthorization"
    ).mockImplementationOnce((home, deps) => {
      const credential = actual(home, deps);
      rotateDesktopLocalCredential(koedHome);
      return credential;
    });
    expect(await resolveOwnerBinding(options)).toBeNull();
  });

  it.each(["malformed", "tampered"])(
    "fails closed on %s custody for bind and recheck",
    async (kind) => {
      const { koedHome, options, credential } = setup();
      const binding = (await resolveOwnerBinding(options))!;
      const path = resolve(koedHome, "secrets/upstream-credentials.json");
      if (kind === "malformed") writeFileSync(path, "not-json");
      else {
        const store = JSON.parse(readFileSync(path, "utf8"));
        const envelope = Object.values(store.secrets)[0] as {
          ciphertext: string;
        };
        envelope.ciphertext = `${envelope.ciphertext.startsWith("A") ? "B" : "A"}${envelope.ciphertext.slice(1)}`;
        writeFileSync(path, JSON.stringify(store));
      }
      const result = await resolveOwnerBinding(options);
      expect(result).toBeNull();
      expect(await recheckOwnerBinding(options, binding)).toBe(false);
      expect(JSON.stringify(result)).not.toContain(credential.authorization);
    }
  );

  it("permits a snapshot to become stale after its final check", async () => {
    const { koedHome, options } = setup();
    const binding = await resolveOwnerBinding(options);
    expect(binding).not.toBeNull();
    expect(
      await recheckOwnerBinding(
        { ...options, resolveActiveLocalUser: async () => null },
        binding!
      )
    ).toBe(false);
    rotateDesktopLocalCredential(koedHome);
    expect(binding?.owner).toBe(`desktop:${binding?.credentialKeyId}`);
    expect(await recheckOwnerBinding(options, binding!)).toBe(false);
  });

  it("rejects rotation observed during the active-user lookup", async () => {
    const { koedHome, options } = setup();
    const racing = {
      ...options,
      resolveActiveLocalUser: async (id: string) => {
        rotateDesktopLocalCredential(koedHome);
        return { id };
      }
    };
    expect(await resolveOwnerBinding(racing)).toBeNull();
    const binding = (await resolveOwnerBinding(options))!;
    expect(await recheckOwnerBinding(racing, binding)).toBe(false);
  });
});
