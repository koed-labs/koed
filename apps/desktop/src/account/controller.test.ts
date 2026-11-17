import { afterEach, describe, expect, it, vi } from "vitest";
import { createAccountController } from "./controller.js";
import type { AccountRuntime } from "./runtime.js";
import type { AccountConfig } from "./config.js";
const FORWARDER_URL = "https://login.example.test/desktop/callback";
const profile = {
  id: "user_1",
  displayName: "Alex",
  email: "alex@example.com",
  emailVerified: true
};
const config: AccountConfig = {
  clientId: "client_desktop",
  environment: "staging",
  loginMode: "forwarder",
  redirectUri: FORWARDER_URL,
  callbackUri: "ai.koed.desktop.auth.dev://callback"
};
function fixture(configuration: AccountConfig = config) {
  let session: unknown = null;
  let pending = false;
  const credentials = {
    accessToken: "sensitive-access",
    refreshToken: "sensitive-refresh",
    user: { id: "user_1" }
  } as Awaited<ReturnType<AccountRuntime["callback"]>>;
  const runtime = {
    begin: vi.fn(async (_screen, isCurrent) => {
      if (isCurrent()) pending = true;
    }),
    hasPending: vi.fn(() => pending),
    cancel: vi.fn(() => {
      pending = false;
    }),
    callback: vi.fn(async () => {
      pending = false;
      return credentials;
    }),
    read: vi.fn(() => session),
    save: vi.fn((value) => {
      session = value;
    }),
    clear: vi.fn(() => {
      const previous = session;
      session = null;
      pending = false;
      return previous;
    }),
    validate: vi.fn(async (value) => ({
      session: value,
      claims: { sub: "user_1" }
    })),
    profile: vi.fn(() => profile),
    end: vi.fn(async () => undefined),
    getProfile: vi.fn(() => null),
    setProfile: vi.fn()
  } as unknown as AccountRuntime;
  const fetch = vi.fn(
    async () => new Response(JSON.stringify(profile), { status: 200 })
  );
  vi.stubGlobal("fetch", fetch);
  const controller = createAccountController({
    config: configuration,
    runtime: () => runtime
  });
  return { controller, runtime, fetch, credentials };
}
afterEach(() => vi.unstubAllGlobals());
describe("optional account lifecycle", () => {
  it("does not initialize provider or networking when unconfigured", async () => {
    const runtime = vi.fn();
    const controller = createAccountController({ config: null, runtime });
    expect((await controller.restore()).status).toBe("unavailable");
    expect(
      (await controller.command({ operation: "signIn", screen: "sign-in" }))
        .status
    ).toBe("unavailable");
    expect(runtime).not.toHaveBeenCalled();
  });
  it("uses validated WorkOS profile data without account API calls", async () => {
    const { controller, runtime, fetch } = fixture();
    const snapshots: unknown[] = [];
    controller.subscribe((state) => snapshots.push(state));
    await controller.command({ operation: "signIn", screen: "sign-in" });
    expect(
      (await controller.command({ operation: "refreshProfile" })).status
    ).toBe("signing_in");
    await controller.callback(
      config.callbackUri + "?code=secret-code&state=sealed"
    );
    expect(controller.current().profile).toEqual(profile);
    expect(runtime.save).toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(snapshots)).not.toMatch(
      /sensitive|secret-code|sealed/
    );
  });
  it("ignores callbacks after cancellation and callbacks from another environment", async () => {
    const { controller, runtime } = fixture();
    await controller.command({ operation: "signIn", screen: "sign-in" });
    await controller.command({ operation: "cancelSignIn" });
    await controller.callback(config.callbackUri + "?code=code&state=sealed");
    expect(
      await controller.callback(
        "ai.koed.desktop.auth://callback?code=code&state=sealed"
      )
    ).toBe(false);
    expect(runtime.callback).not.toHaveBeenCalled();
  });
  it("cannot restore a profile when sign-out races an in-flight WorkOS exchange", async () => {
    const { controller, runtime, credentials } = fixture();
    let release!: (value: typeof credentials) => void;
    vi.mocked(runtime.callback).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }) as ReturnType<AccountRuntime["callback"]>
    );
    await controller.command({ operation: "signIn", screen: "sign-in" });
    const callback = controller.callback(
      config.callbackUri + "?code=code&state=sealed"
    );
    await vi.waitFor(() => expect(runtime.callback).toHaveBeenCalled());
    await controller.command({ operation: "signOut" });
    release(credentials);
    await callback;
    expect(controller.current().status).toBe("signed_out");
    expect(controller.current().profile).toBeNull();
    expect(runtime.save).not.toHaveBeenCalled();
  });
  it("ignores a duplicate callback after the first exchange succeeds", async () => {
    const { controller, runtime } = fixture();
    await controller.command({ operation: "signIn", screen: "sign-in" });
    const url = config.callbackUri + "?code=code&state=sealed";
    await Promise.all([controller.callback(url), controller.callback(url)]);
    expect(runtime.callback).toHaveBeenCalledTimes(1);
    expect(controller.current().status).toBe("signed_in");
    expect(controller.current().stale).toBe(false);
    expect(controller.current().message).toBeNull();
  });
  it("does not publish a profile when sign-out overtakes an asynchronous credential save", async () => {
    const { controller, runtime } = fixture();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(runtime.save).mockImplementationOnce(async () => blocked);
    await controller.command({ operation: "signIn", screen: "sign-in" });
    const callback = controller.callback(
      config.callbackUri + "?code=code&state=sealed"
    );
    await vi.waitFor(() => expect(runtime.save).toHaveBeenCalled());
    await controller.command({ operation: "signOut" });
    expect(controller.current().profile).toBeNull();
    release();
    await callback;
    expect(runtime.setProfile).not.toHaveBeenCalled();
    expect(controller.current().status).toBe("signed_out");
  });
  it("expires a browser handoff without preventing local use", async () => {
    vi.useFakeTimers();
    try {
      const { controller, runtime } = fixture();
      await controller.command({ operation: "signIn", screen: "sign-in" });
      await vi.advanceTimersByTimeAsync(600000);
      expect(controller.current().status).toBe("signed_out");
      expect(controller.current().message).toContain("expired");
      expect(runtime.cancel).toHaveBeenCalled();
      await controller.callback(config.callbackUri + "?code=code&state=sealed");
      expect(runtime.callback).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("clears locally when remote logout fails and reports the limitation", async () => {
    const { controller, runtime, fetch } = fixture();
    await controller.command({ operation: "signIn", screen: "sign-in" });
    await controller.callback(config.callbackUri + "?code=code&state=sealed");
    vi.mocked(runtime.end).mockRejectedValueOnce(new Error("offline"));
    await controller.command({ operation: "signOut" });
    expect(runtime.clear).toHaveBeenCalled();
    expect(controller.current().profile).toBeNull();
    expect(controller.current().message).toContain("could not be opened");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("accepts only the exact native callback and leaves pending sign-in intact for malformed responses", async () => {
    const { controller, runtime } = fixture();
    await controller.command({ operation: "signIn", screen: "sign-in" });
    for (const value of [
      config.redirectUri + "?code=code&state=sealed",
      config.callbackUri + "/?code=code&state=sealed",
      config.callbackUri + "?code=code&state=sealed#fragment",
      config.callbackUri + "?code=code&state=sealed&state=other",
      config.callbackUri + "?code=code&state=sealed&code=other",
      config.callbackUri +
        "?error=access_denied&error=server_error&state=sealed",
      config.callbackUri + "?error=access_denied&code=code&state=sealed",
      config.callbackUri + "?code=&state=sealed",
      config.callbackUri + "?code=code&state=",
      "ai.koed.desktop.auth.dev://user:pass@callback?code=code&state=sealed",
      "ai.koed.desktop.auth.dev://callback.attacker.test?code=code&state=sealed"
    ]) {
      expect(await controller.callback(value)).toBe(false);
    }
    expect(controller.current().status).toBe("signing_in");
    expect(runtime.callback).not.toHaveBeenCalled();
    await controller.callback(config.callbackUri + "?code=code&state=sealed");
    expect(controller.current().status).toBe("signed_in");
  });
  it("consumes matching provider errors once without echoing their payload or exchanging a code", async () => {
    vi.useFakeTimers();
    try {
      const { controller, runtime } = fixture();
      await controller.command({ operation: "signIn", screen: "sign-in" });
      const error =
        config.callbackUri + "?error=private-provider-detail&state=sealed";
      await Promise.all([
        controller.callback(error),
        controller.callback(error)
      ]);
      expect(runtime.cancel).toHaveBeenCalledTimes(1);
      expect(runtime.callback).not.toHaveBeenCalled();
      expect(controller.current()).toMatchObject({
        status: "signed_out",
        profile: null,
        busy: false,
        message: "Sign-in did not complete. Try again when you are ready."
      });
      await vi.advanceTimersByTimeAsync(600000);
      expect(controller.current().message).not.toContain("expired");
      expect(JSON.stringify(controller.current())).not.toMatch(
        /private-provider-detail|sealed/
      );
      await controller.command({ operation: "signIn", screen: "sign-in" });
      expect(controller.current().status).toBe("signing_in");
    } finally {
      vi.useRealTimers();
    }
  });
  it("ignores a provider error without a pending attempt and supports direct-mode rollback", async () => {
    const { controller, runtime } = fixture({
      ...config,
      loginMode: "direct",
      redirectUri: config.callbackUri
    });
    await controller.restore();
    await controller.callback(
      config.callbackUri + "?error=access_denied&state=forged"
    );
    expect(runtime.cancel).not.toHaveBeenCalled();
    expect(controller.current().message).toBeNull();
    await controller.command({ operation: "signIn", screen: "sign-in" });
    await controller.callback(config.callbackUri + "?code=code&state=sealed");
    expect(controller.current().status).toBe("signed_in");
  });
});
