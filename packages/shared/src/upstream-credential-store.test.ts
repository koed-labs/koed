import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deleteLocalEdgeClientCredential,
  deleteUpstreamCredentialSecret,
  readLocalEdgeClientCredentialAuthorization,
  parseUpstreamCredentialReference,
  readUpstreamCredentialAuthorization,
  storeLocalEdgeClientCredential,
  storeUpstreamCredentialSecret,
  upstreamCredentialReferenceFor,
  verifyLocalEdgeClientCredentialAuthorization
} from "./upstream-credential-store.js";

const temps: string[] = [];

const tempHome = (): string => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-upstream-secret-"));
  temps.push(root);
  return root;
};

afterEach(() => {
  for (const path of temps.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("upstream credential secret store", () => {
  it("stores only an encrypted local secret behind a stable reference", () => {
    const koedHome = tempHome();

    const { reference } = storeUpstreamCredentialSecret(koedHome, {
      backendId: "team-vps",
      credentialKeyId: "koed_device_1",
      secret: "plain-device-secret"
    });

    expect(reference).toBe(
      upstreamCredentialReferenceFor({
        backendId: "team-vps",
        credentialKeyId: "koed_device_1"
      })
    );
    expect(parseUpstreamCredentialReference(reference)).toEqual({
      backendId: "team-vps",
      credentialKeyId: "koed_device_1"
    });
    expect(readUpstreamCredentialAuthorization(koedHome, reference)).toBe(
      "Koed-Device koed_device_1:plain-device-secret"
    );

    const storeText = readFileSync(
      resolve(koedHome, "secrets", "upstream-credentials.json"),
      "utf8"
    );
    expect(storeText).not.toContain("plain-device-secret");
    expect(storeText).toContain(reference);
    expect(
      statSync(resolve(koedHome, "secrets", "upstream-credentials.json")).mode &
        0o777
    ).toBe(0o600);
    expect(
      statSync(resolve(koedHome, "config", "local-secret-store.key")).mode &
        0o777
    ).toBe(0o600);
  });

  it("deletes stored secrets without accepting malformed references", () => {
    const koedHome = tempHome();
    const { reference } = storeUpstreamCredentialSecret(koedHome, {
      backendId: "team-vps",
      credentialKeyId: "koed_device_2",
      secret: "device-secret"
    });

    expect(deleteUpstreamCredentialSecret(koedHome, "bearer-secret")).toBe(
      false
    );
    expect(deleteUpstreamCredentialSecret(koedHome, reference)).toBe(true);
    expect(readUpstreamCredentialAuthorization(koedHome, reference)).toBeNull();
    expect(deleteUpstreamCredentialSecret(koedHome, reference)).toBe(false);
  });

  it("stores a distinct scoped local-edge client credential", () => {
    const koedHome = tempHome();
    storeLocalEdgeClientCredential(koedHome, {
      backendId: "team-vps",
      secret: "local-client-secret",
      operationFamilies: ["team_workspace_read"]
    });

    const stored = readLocalEdgeClientCredentialAuthorization(
      koedHome,
      "team-vps"
    );
    expect(stored).toMatchObject({
      backendId: "team-vps",
      operationFamilies: ["team_workspace_read"]
    });
    expect(stored?.authorization).toContain("Koed-Device koed_local_");
    expect(stored?.authorization).toContain(":local-client-secret");
    expect(
      verifyLocalEdgeClientCredentialAuthorization(
        koedHome,
        stored?.authorization,
        {
          backendId: "team-vps",
          operationFamily: "team_workspace_read"
        }
      )
    ).toMatchObject({ backendId: "team-vps" });
    expect(
      verifyLocalEdgeClientCredentialAuthorization(
        koedHome,
        stored?.authorization,
        { backendId: "team-vps", operationFamily: "admin" }
      )
    ).toBeNull();
    expect(deleteLocalEdgeClientCredential(koedHome, "team-vps")).toBe(true);
    expect(
      readLocalEdgeClientCredentialAuthorization(koedHome, "team-vps")
    ).toBeNull();
  });

  it("rejects ambiguous header values and fails closed on damaged storage", () => {
    const koedHome = tempHome();
    expect(() =>
      storeUpstreamCredentialSecret(koedHome, {
        backendId: "team-vps",
        credentialKeyId: "credential:key",
        secret: "secret"
      })
    ).toThrow("credentialKeyId is not valid");
    expect(() =>
      storeUpstreamCredentialSecret(koedHome, {
        backendId: "team-vps",
        credentialKeyId: "credential-key",
        secret: "secret\r\nInjected: true"
      })
    ).toThrow("Upstream credential secret is not valid");
    storeUpstreamCredentialSecret(koedHome, {
      backendId: "team-vps",
      credentialKeyId: "credential-key",
      secret: "safe-secret"
    });
    const reference = upstreamCredentialReferenceFor({
      backendId: "team-vps",
      credentialKeyId: "credential-key"
    });
    expect(readUpstreamCredentialAuthorization(koedHome, reference)).toBe(
      "Koed-Device credential-key:safe-secret"
    );

    storeLocalEdgeClientCredential(koedHome, {
      backendId: "team-vps",
      secret: "local-client-secret",
      operationFamilies: ["team_workspace_read"]
    });
    unlinkSync(resolve(koedHome, "config", "local-secret-store.key"));
    expect(readUpstreamCredentialAuthorization(koedHome, reference)).toBeNull();
    expect(
      readLocalEdgeClientCredentialAuthorization(koedHome, "team-vps")
    ).toBeNull();
    expect(() =>
      storeUpstreamCredentialSecret(koedHome, {
        backendId: "team-vps",
        credentialKeyId: "replacement-key",
        secret: "replacement-secret"
      })
    ).toThrow("missing or invalid");

    writeFileSync(
      resolve(koedHome, "secrets", "upstream-credentials.json"),
      "not-json",
      "utf8"
    );
    expect(readUpstreamCredentialAuthorization(koedHome, reference)).toBeNull();
  });
});
