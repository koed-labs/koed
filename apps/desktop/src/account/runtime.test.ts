import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthKitCore, TokenRefreshError } from "@workos/authkit-session";
import type { Session } from "@workos/authkit-session";
const os = vi.hoisted(() => ({
  directory: "",
  available: true,
  rotate: false
}));
vi.mock("electron", () => ({
  app: { getPath: () => os.directory },
  safeStorage: {
    isAsyncEncryptionAvailable: vi.fn(async () => os.available),
    getSelectedStorageBackend: () => "gnome_libsecret",
    // Reversible test double for the OS encryption boundary, not cryptography.
    encryptStringAsync: vi.fn(async (value: string) =>
      Buffer.from(value).reverse()
    ),
    decryptStringAsync: vi.fn(async (value: Buffer) => {
      const shouldReEncrypt = os.rotate;
      os.rotate = false;
      return {
        result: Buffer.from(value).reverse().toString(),
        shouldReEncrypt
      };
    }),
    isEncryptionAvailable: () => {
      throw new Error("Deprecated API used");
    },
    encryptString: () => {
      throw new Error("Deprecated API used");
    },
    decryptString: () => {
      throw new Error("Deprecated API used");
    }
  }
}));
import { safeStorage } from "electron";
import { createAccountRuntime } from "./runtime.js";
import type { AccountConfig } from "./config.js";
const FORWARDER_URL = "https://login.example.test/desktop/callback";
const config: AccountConfig = {
  clientId: "client_test",
  environment: "staging",
  loginMode: "forwarder",
  redirectUri: FORWARDER_URL,
  callbackUri: "ai.koed.desktop.auth.dev://callback"
};
const session = {
  accessToken: "private-access-material",
  refreshToken: "private-refresh-material",
  user: { id: "user_1" }
} as Session;
beforeEach(() => {
  vi.clearAllMocks();
  const root = resolve("scratch");
  mkdirSync(root, { recursive: true });
  os.directory = mkdtempSync(resolve(root, "account-storage-"));
  os.available = true;
  os.rotate = false;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(os.directory, { recursive: true, force: true });
});
describe("account persistence boundary", () => {
  it("initializes asynchronous encryption only when account storage is used", async () => {
    const runtime = createAccountRuntime(config, vi.fn());
    expect(safeStorage.isAsyncEncryptionAvailable).not.toHaveBeenCalled();
    await expect(runtime.read()).resolves.toBeNull();
    expect(safeStorage.isAsyncEncryptionAvailable).toHaveBeenCalled();
  });
  it("re-encrypts when Electron reports key rotation without changing the session", async () => {
    const runtime = createAccountRuntime(config, vi.fn());
    await runtime.save(session);
    vi.mocked(safeStorage.encryptStringAsync).mockClear();
    os.rotate = true;
    expect(await runtime.read()).toEqual(session);
    expect(safeStorage.encryptStringAsync).toHaveBeenCalledTimes(1);
    expect(readdirSync(os.directory)).toHaveLength(1);
    expect(await createAccountRuntime(config, vi.fn()).read()).toEqual(session);
  });
  it("keeps the previous encrypted file intact after a temporary encryption failure", async () => {
    const runtime = createAccountRuntime(config, vi.fn());
    await runtime.save(session);
    vi.mocked(safeStorage.encryptStringAsync).mockRejectedValueOnce(
      new Error("Keychain locked")
    );
    const next = { ...session, refreshToken: "rotated-refresh-material" };
    await expect(runtime.save(next)).rejects.toMatchObject({
      code: "storage_unavailable",
      cause: expect.objectContaining({ message: "Keychain locked" })
    });
    expect(await runtime.read()).toEqual(session);
    expect(readdirSync(os.directory)).toHaveLength(1);
    await runtime.save(next);
    expect(await runtime.read()).toEqual(next);
  });
  it("immediately clears the file and rejects a write that finishes encryption after sign-out", async () => {
    const runtime = createAccountRuntime(config, vi.fn());
    await runtime.save(session);
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.mocked(safeStorage.encryptStringAsync).mockImplementationOnce(
      async (value) => {
        started();
        await blocked;
        return Buffer.from(value).reverse();
      }
    );
    const saving = runtime.save({ ...session, refreshToken: "later-refresh" });
    const rejected = expect(saving).rejects.toMatchObject({
      code: "storage_unavailable",
      cause: expect.objectContaining({
        message: expect.stringContaining("cancelled")
      })
    });
    await entered;
    expect(runtime.clear()?.user.id).toBe("user_1");
    expect(readdirSync(os.directory)).toEqual([]);
    release();
    await rejected;
    expect(readdirSync(os.directory)).toEqual([]);
    expect(await createAccountRuntime(config, vi.fn()).read()).toBeNull();
  });
  it("cancels a pending encryption operation without opening a late login browser", async () => {
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.mocked(safeStorage.encryptStringAsync).mockImplementationOnce(
      async (value) => {
        started();
        await blocked;
        return Buffer.from(value).reverse();
      }
    );
    const open = vi.fn(async (_url: string) => undefined);
    const runtime = createAccountRuntime(config, open);
    const begin = runtime.begin("sign-in", () => true);
    const rejected = expect(begin).rejects.toMatchObject({
      code: "storage_unavailable",
      cause: expect.objectContaining({
        message: expect.stringContaining("cancelled")
      })
    });
    await entered;
    runtime.cancel();
    release();
    await rejected;
    expect(open).not.toHaveBeenCalled();
    expect(readdirSync(os.directory)).toEqual([]);
    await runtime.begin("sign-in", () => true);
    expect(open).toHaveBeenCalledTimes(1);
  });
  it("cannot restore cached credentials when a decrypt finishes after local clearing", async () => {
    const runtime = createAccountRuntime(config, vi.fn());
    await runtime.save(session);
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.mocked(safeStorage.decryptStringAsync).mockImplementationOnce(
      async (encrypted) => {
        started();
        await blocked;
        return {
          result: Buffer.from(encrypted).reverse().toString(),
          shouldReEncrypt: false
        };
      }
    );
    const reading = runtime.read();
    const rejected = expect(reading).rejects.toMatchObject({
      code: "storage_unavailable",
      cause: expect.objectContaining({
        message: expect.stringContaining("cancelled")
      })
    });
    await entered;
    expect(runtime.clear()?.user.id).toBe("user_1");
    release();
    await rejected;
    expect(runtime.clear()).toBeNull();
    expect(readdirSync(os.directory)).toEqual([]);
  });
  it("restores through the OS encryption adapter and isolates applications", async () => {
    const first = createAccountRuntime(config, vi.fn());
    await first.save(session);
    const stored = readFileSync(
      resolve(os.directory, readdirSync(os.directory)[0]!)
    ).toString();
    expect(stored).not.toContain(session.accessToken);
    expect(stored).not.toContain(session.refreshToken);
    expect(await createAccountRuntime(config, vi.fn()).read()).toEqual(session);
    expect(
      await createAccountRuntime(
        { ...config, clientId: "client_other" },
        vi.fn()
      ).read()
    ).toBeNull();
  });
  it("never persists credentials without OS encryption", async () => {
    const runtime = createAccountRuntime(config, vi.fn());
    os.available = false;
    await expect(runtime.save(session)).rejects.toMatchObject({
      code: "storage_unavailable"
    });
    expect(readdirSync(os.directory)).toEqual([]);
  });
  it("removes cached identity and credentials together on sign-out", async () => {
    const runtime = createAccountRuntime(config, vi.fn());
    await runtime.save(session);
    await runtime.setProfile({
      id: "user_1",
      email: "alex@example.com",
      displayName: "Alex",
      emailVerified: true
    });
    runtime.clear();
    const restored = createAccountRuntime(config, vi.fn());
    expect(await restored.read()).toBeNull();
    expect(await restored.getProfile()).toBeNull();
  });
  it("publishes only the verified WorkOS User matching the validated subject", async () => {
    const runtime = createAccountRuntime(config, vi.fn());
    const validated = {
      session: {
        ...session,
        user: {
          id: "user_1",
          email: "alex@example.com",
          emailVerified: true,
          firstName: "Alex",
          lastName: "Example",
          profilePictureUrl: "https://images.workoscdn.com/avatar/alex.png"
        }
      },
      claims: { sub: "user_1" }
    } as Parameters<typeof runtime.profile>[0];
    expect(runtime.profile(validated)).toEqual({
      id: "user_1",
      displayName: "Alex Example",
      email: "alex@example.com",
      emailVerified: true,
      profilePictureUrl: "https://images.workoscdn.com/avatar/alex.png"
    });
    expect(() =>
      runtime.profile({
        ...validated,
        claims: { ...validated.claims, sub: "user_other" }
      })
    ).toThrow("Verified WorkOS identity");
    expect(() =>
      runtime.profile({
        ...validated,
        session: {
          ...validated.session,
          user: { ...validated.session.user, emailVerified: false }
        }
      })
    ).toThrow("Verified WorkOS identity");
  });
  it("treats missing, unsafe, or unsupported pictures as presentation fallbacks without rejecting sign-in", async () => {
    const runtime = createAccountRuntime(config, vi.fn());
    const validated = {
      session: {
        ...session,
        user: { id: "user_1", email: "alex@example.com", emailVerified: true }
      },
      claims: { sub: "user_1" }
    } as Parameters<typeof runtime.profile>[0];
    for (const profilePictureUrl of [
      undefined,
      null,
      "not-a-url",
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      "file:///private/photo.png",
      "http://images.workoscdn.com/photo.png",
      "https://127.0.0.1/photo.png",
      "https://images.workoscdn.com.attacker.test/photo.png",
      "https://user:password@images.workoscdn.com/photo.png",
      "https://images.workoscdn.com:444/photo.png"
    ]) {
      expect(
        runtime.profile({
          ...validated,
          session: {
            ...validated.session,
            user: { ...validated.session.user, profilePictureUrl }
          }
        } as Parameters<typeof runtime.profile>[0])
      ).toMatchObject({
        id: "user_1",
        email: "alex@example.com",
        profilePictureUrl: null
      });
    }
    for (const profilePictureUrl of [
      "https://workoscdn.com/images/v1/alex",
      "https://images.workoscdn.com/avatar/alex.png",
      "https://lh3.googleusercontent.com/a/alex",
      "https://avatars.githubusercontent.com/u/123?v=4"
    ]) {
      expect(
        runtime.profile({
          ...validated,
          session: {
            ...validated.session,
            user: { ...validated.session.user, profilePictureUrl }
          }
        }).profilePictureUrl
      ).toBe(profilePictureUrl);
    }
  });
  it("recognizes the SDK OAuth error field for a terminal refresh failure", async () => {
    const runtime = createAccountRuntime(config, vi.fn());
    const validate = vi.spyOn(AuthKitCore.prototype, "validateAndRefresh");
    try {
      validate.mockRejectedValueOnce(
        new TokenRefreshError("Refresh failed", { error: "invalid_grant" })
      );
      await expect(runtime.validate(session)).rejects.toMatchObject({
        name: "TokenValidationError"
      });
      const transient = new TokenRefreshError(
        "Refresh failed",
        new Error("offline")
      );
      validate.mockRejectedValueOnce(transient);
      await expect(runtime.validate(session)).rejects.toBe(transient);
    } finally {
      validate.mockRestore();
    }
  });
  it("cancellation while encryption is unavailable survives a restart", async () => {
    const open = vi.fn(async (_url: string) => undefined);
    const runtime = createAccountRuntime(config, open);
    await runtime.begin("sign-in", () => true);
    const state = new URL(open.mock.calls[0]![0]).searchParams.get("state")!;
    os.available = false;
    runtime.cancel();
    os.available = true;
    expect(await createAccountRuntime(config, open).hasPending(state)).toBe(
      false
    );
    await runtime.begin("sign-in", () => true);
    const nextState = new URL(open.mock.calls[1]![0]).searchParams.get(
      "state"
    )!;
    expect(await createAccountRuntime(config, open).hasPending(nextState)).toBe(
      true
    );
  });
  it("preserves pending authorization across restart and invalidates it on cancel", async () => {
    const open = vi.fn(async (_url: string) => undefined);
    await createAccountRuntime(config, open).begin("sign-in", () => true);
    const url = new URL(open.mock.calls[0]![0] as unknown as string);
    const state = url.searchParams.get("state")!;
    expect(state).toBeTruthy();
    const restored = createAccountRuntime(config, open);
    expect(await restored.hasPending(state)).toBe(true);
    restored.cancel();
    expect(await restored.hasPending(state)).toBe(false);
  });
  it("retains legacy encrypted sessions in place and discards legacy pending attempts", async () => {
    const legacyConfig = {
      clientId: config.clientId,
      environment: config.environment,
      redirectUri: config.callbackUri
    };
    const legacyScope = createHash("sha256")
      .update(JSON.stringify(legacyConfig))
      .digest("hex");
    const file = resolve(os.directory, `koed-account-${legacyScope}.bin`);
    const profile = {
      id: "user_1",
      email: "alex@example.com",
      emailVerified: true,
      displayName: "Alex"
    };
    writeFileSync(
      file,
      Buffer.from(
        JSON.stringify({
          session,
          password: "test-per-install-password-with-32-characters",
          pending: { state: "old-attempt", expires: Date.now() + 600000 },
          profile
        })
      ).reverse()
    );
    const runtime = createAccountRuntime(config, vi.fn());
    expect(await runtime.read()).toEqual(session);
    expect(await runtime.getProfile()).toEqual(profile);
    expect(await runtime.hasPending("old-attempt")).toBe(false);
    expect(readdirSync(os.directory)).toEqual([
      `koed-account-${legacyScope}.bin`
    ]);
    const rollback = createAccountRuntime(
      {
        ...config,
        loginMode: "direct",
        redirectUri: config.callbackUri
      },
      vi.fn()
    );
    expect(await rollback.read()).toEqual(session);
    runtime.clear();
    expect(await rollback.read()).toBeNull();
    expect(await rollback.getProfile()).toBeNull();
    expect(await createAccountRuntime(config, vi.fn()).read()).toBeNull();
  });
  it("retains the session but discards pending attempts when the configured forwarder changes", async () => {
    const open = vi.fn(async (_url: string) => undefined);
    const runtime = createAccountRuntime(config, open);
    await runtime.save(session);
    await runtime.begin("sign-in", () => true);
    const state = new URL(open.mock.calls[0]![0]).searchParams.get("state")!;
    const changed = createAccountRuntime(
      {
        ...config,
        redirectUri: "https://replacement.example.test/desktop/callback"
      },
      open
    );
    expect(await changed.read()).toEqual(session);
    expect(await changed.hasPending(state)).toBe(false);
    expect(await runtime.hasPending(state)).toBe(false);
    expect(readdirSync(os.directory)).toHaveLength(1);
  });
  it("invalidates mode-specific pending attempts permanently while retaining the session", async () => {
    const open = vi.fn(async (_url: string) => undefined);
    const runtime = createAccountRuntime(config, open);
    await runtime.save(session);
    await runtime.begin("sign-in", () => true);
    const state = new URL(open.mock.calls[0]![0]).searchParams.get("state")!;
    const rollback = createAccountRuntime(
      {
        ...config,
        loginMode: "direct",
        redirectUri: config.callbackUri
      },
      open
    );
    expect(await rollback.hasPending(state)).toBe(false);
    expect(await rollback.read()).toEqual(session);
    expect(await runtime.hasPending(state)).toBe(false);
    await rollback.begin("sign-in", () => true);
    const directUrl = new URL(open.mock.calls[1]![0]);
    expect(directUrl.searchParams.get("redirect_uri")).toBe(config.callbackUri);
    expect(
      await createAccountRuntime(config, open).hasPending(
        directUrl.searchParams.get("state")!
      )
    ).toBe(false);
  });
  it("rejects inherited administrative keys before client construction while preserving local credential access", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("WORKOS_API_KEY", "synthetic-administrative-key-never-send");
    const open = vi.fn();
    const runtime = createAccountRuntime(config, open);
    await runtime.save(session);
    expect(await runtime.read()).toEqual(session);
    await expect(runtime.begin("sign-in", () => true)).rejects.toMatchObject({
      code: "configuration_invalid"
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(runtime.clear()).toEqual(session);
    expect(process.env.WORKOS_API_KEY).toBe(
      "synthetic-administrative-key-never-send"
    );
  });
  it("uses the HTTPS redirect with real SDK PKCE and exchanges only in main with WorkOS", async () => {
    const fetch = vi.fn(
      async (_url: unknown, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            access_token: session.accessToken,
            refresh_token: session.refreshToken,
            user: {
              object: "user",
              id: "user_1",
              email: "alex@example.com",
              email_verified: true,
              first_name: "Alex",
              last_name: null,
              created_at: "2026-11-17T00:00:00.000Z",
              updated_at: "2026-11-17T00:00:00.000Z"
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    );
    vi.stubGlobal("fetch", fetch);
    const open = vi.fn(async (_url: string) => undefined);
    await createAccountRuntime(config, open).begin("sign-up", () => true);
    const authorization = new URL(open.mock.calls[0]![0]);
    expect(authorization.searchParams.get("redirect_uri")).toBe(FORWARDER_URL);
    expect(authorization.searchParams.get("screen_hint")).toBe("sign-up");
    expect(authorization.searchParams.get("code_challenge_method")).toBe(
      "S256"
    );
    expect(fetch).not.toHaveBeenCalled();
    const restored = createAccountRuntime(config, open);
    const state = authorization.searchParams.get("state")!;
    const result = await restored.callback("synthetic-code", state);
    expect(result.accessToken).toBe(session.accessToken);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://api.workos.com/user_management/authenticate"
    );
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      client_id: config.clientId,
      grant_type: "authorization_code",
      code: "synthetic-code"
    });
    expect(body.client_secret).toBeUndefined();
    expect(new Headers(init?.headers).get("authorization")).toBeNull();
    expect(JSON.stringify(fetch.mock.calls)).not.toContain(
      "synthetic-administrative-key-never-send"
    );
    expect(
      createHash("sha256").update(body.code_verifier).digest("base64url")
    ).toBe(authorization.searchParams.get("code_challenge"));
    await expect(restored.callback("synthetic-code", state)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
