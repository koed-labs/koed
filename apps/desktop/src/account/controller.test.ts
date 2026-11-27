import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAccountController } from "./controller.js";
import type { AccountRuntime } from "./runtime.js";
import type { AccountConfig } from "./config.js";
import { AccountOperationError } from "./errors.js";
const FORWARDER_URL = "https://login.example.test/desktop/callback";
const profile = {
  id: "user_1",
  displayName: "Alex",
  email: "alex@example.com",
  emailVerified: true
};
const details = {
  userId: profile.id,
  emailUpdates: {
    email: profile.email,
    subscribed: false,
    revision: 0,
    noticeVersion: "fixture-v1",
    noticeText: "Synthetic consent check."
  },
  kin: { unlockMask: "0x0", catalogVersion: "1.1.0" }
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
async function signedInWithEmailPreference() {
  const f = fixture({
    ...config,
    profileApiOrigin: "https://account.example.test"
  });
  f.fetch.mockResolvedValueOnce(Response.json(details));
  await f.controller.command({ operation: "signIn", screen: "sign-in" });
  await f.controller.callback(config.callbackUri + "?code=code&state=sealed");
  f.fetch.mockClear();
  vi.mocked(f.runtime.validate).mockClear();
  const renewal = {
    valid: true,
    refreshed: true,
    session: {
      ...f.credentials,
      accessToken: "renewed-access",
      refreshToken: "renewed-refresh"
    },
    claims: { sub: profile.id, sid: "fixture-session" }
  };
  return { ...f, renewal };
}
afterEach(() => vi.unstubAllGlobals());
describe("optional account lifecycle", () => {
  it.each([
    "checked",
    "skipped",
    "sign-in",
    "existing",
    "stale notice",
    "prior preference",
    "other email",
    "duplicate",
    "api failure"
  ])(
    "handles browser signup consent for %s without blocking sign-in",
    async (scenario) => {
      const { controller, runtime, credentials, fetch } = fixture({
        ...config,
        profileApiOrigin: "https://account.example.test"
      });
      const startedAt = Date.now() - 2000;
      const nonce = "synthetic-attempt";
      const pref = { ...details.emailUpdates };
      const proof = createHash("sha256")
        .update(JSON.stringify([nonce, pref.noticeVersion, pref.noticeText]))
        .digest("hex");
      if (scenario === "stale notice") pref.noticeText += " Revised.";
      if (scenario === "prior preference") pref.revision = 2;
      if (scenario === "other email") pref.email = "changed@example.test";
      vi.mocked(runtime.callback).mockImplementation(async () => {
        vi.mocked(runtime.hasPending).mockResolvedValue(false);
        return {
          ...credentials,
          signup: scenario === "sign-in" ? undefined : { nonce, startedAt }
        };
      });
      vi.mocked(runtime.profile).mockReturnValue({
        ...profile,
        joinedAt: new Date(
          startedAt + (scenario === "existing" ? -1000 : 1000)
        ).toISOString()
      });
      fetch.mockResolvedValueOnce(
        Response.json({ ...details, emailUpdates: pref })
      );
      fetch.mockResolvedValueOnce(
        scenario === "api failure"
          ? new Response(null, { status: 503 })
          : Response.json({ ...pref, revision: 1, subscribed: true })
      );
      await controller.command({
        operation: "signIn",
        screen: scenario === "sign-in" ? "sign-in" : "sign-up"
      });
      const callback = new URL(config.callbackUri + "?code=code&state=sealed");
      if (scenario !== "skipped")
        callback.searchParams.set("signup_opt_in", proof);
      if (scenario === "duplicate")
        callback.searchParams.append("signup_opt_in", proof);
      await controller.callback(callback.href);
      await controller.callback(callback.href);
      expect(controller.current().status).toBe("signed_in");
      const writes = vi
        .mocked(globalThis.fetch)
        .mock.calls.filter(([, init]) => init?.method === "PUT");
      if (scenario === "checked" || scenario === "api failure") {
        expect(writes).toHaveLength(1);
        expect(String(writes[0]![0])).toBe(
          "https://account.example.test/v1/account/signup-email-updates"
        );
        expect(JSON.parse(String(writes[0]![1]?.body))).toEqual({
          email: pref.email,
          noticeVersion: pref.noticeVersion,
          noticeText: pref.noticeText
        });
        expect(controller.current().details).toMatchObject(
          scenario === "checked"
            ? { status: "ready", value: { emailUpdates: { subscribed: true } } }
            : { status: "unavailable" }
        );
      } else expect(writes).toHaveLength(0);
      expect(JSON.stringify(vi.mocked(runtime.save).mock.calls)).not.toContain(
        nonce
      );
    }
  );
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
  it("loads only the signed-in profile and lets the User retry an unavailable account API", async () => {
    const profileApiOrigin = "https://account.example.test";
    const { controller, fetch, credentials } = fixture({
      ...config,
      profileApiOrigin
    });
    const snapshots: unknown[] = [];
    controller.subscribe((state) => snapshots.push(state));
    fetch
      .mockResolvedValueOnce(Response.json({ ...details, userId: "user_2" }))
      .mockResolvedValueOnce(Response.json(details));

    await controller.command({ operation: "signIn", screen: "sign-in" });
    await controller.callback(
      config.callbackUri + "?code=secret-code&state=sealed"
    );
    expect(controller.current()).toMatchObject({
      status: "signed_in",
      profile,
      details: { status: "unavailable" }
    });
    expect(fetch).toHaveBeenCalledWith(
      new URL("/v1/account/profile", profileApiOrigin),
      expect.objectContaining({
        headers: { Authorization: `Bearer ${credentials.accessToken}` },
        redirect: "error"
      })
    );
    expect(
      await controller.command({ operation: "refreshProfile" })
    ).toMatchObject({
      status: "signed_in",
      details: { status: "ready", value: details }
    });
    expect(JSON.stringify(snapshots)).not.toMatch(
      /sensitive|secret-code|sealed|user_2/
    );
  });
  it("saves the renewed session before sending an email preference with its access token", async () => {
    const { controller, runtime, fetch, credentials, renewal } =
      await signedInWithEmailPreference();
    vi.mocked(runtime.validate).mockResolvedValueOnce(renewal);
    const subscribed = {
      ...details.emailUpdates,
      subscribed: true,
      revision: 1
    };
    fetch.mockImplementationOnce(async () => {
      expect(await runtime.read()).toEqual(renewal.session);
      return Response.json(subscribed);
    });
    const next = await controller.command({
      operation: "setEmailUpdates",
      subscribed: true,
      stateRevision: controller.current().revision
    });
    expect(runtime.validate).toHaveBeenCalledWith(credentials);
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://account.example.test/v1/account/email-updates"),
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          Authorization: "Bearer renewed-access"
        })
      })
    );
    expect(next.details).toEqual({
      status: "ready",
      value: { ...details, emailUpdates: subscribed }
    });
  });

  it("keeps consent unconfirmed when the renewed session cannot be saved", async () => {
    const { controller, runtime, fetch, renewal } =
      await signedInWithEmailPreference();
    vi.mocked(runtime.validate).mockResolvedValueOnce(renewal);
    vi.mocked(runtime.save).mockRejectedValueOnce(
      new Error("Storage unavailable")
    );
    const next = await controller.command({
      operation: "setEmailUpdates",
      subscribed: true,
      stateRevision: controller.current().revision
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(next).toMatchObject({
      busy: false,
      messageCode: "email_updates_unconfirmed"
    });
  });

  it.each(["signOut", "reportProfileOffline"] as const)(
    "does not send consent when %s interrupts token renewal",
    async (operation) => {
      const { controller, runtime, fetch, renewal } =
        await signedInWithEmailPreference();
      let resume!: () => void;
      const pending = new Promise<void>((resolve) => {
        resume = resolve;
      });
      vi.mocked(runtime.validate).mockImplementationOnce(async () => {
        await pending;
        return renewal;
      });
      const save = controller.command({
        operation: "setEmailUpdates",
        subscribed: true,
        stateRevision: controller.current().revision
      });
      await vi.waitFor(() => expect(runtime.validate).toHaveBeenCalledOnce());
      await controller.command({ operation });
      resume();
      const next = await save;
      expect(fetch).not.toHaveBeenCalled();
      expect(next.busy).toBe(false);
      expect(await runtime.read()).toEqual(
        operation === "signOut" ? null : renewal.session
      );
    }
  );

  it("requires a new profile read after going offline and ignores late account data", async () => {
    const { controller, fetch, runtime, credentials } = fixture({
      ...config,
      profileApiOrigin: "https://account.example.test"
    });
    const profileDetails = (userId: string, unlockMask: string) => ({
      userId,
      emailUpdates: {
        email: "fixture@example.test",
        subscribed: false,
        revision: 0,
        noticeVersion: "fixture-v1",
        noticeText: "Synthetic consent check."
      },
      kin: { unlockMask, catalogVersion: "1.1.0" }
    });
    const first = profileDetails(profile.id, "0x1");
    fetch.mockResolvedValueOnce(Response.json(first));
    await controller.command({ operation: "signIn", screen: "sign-in" });
    await controller.callback(config.callbackUri + "?code=first&state=proof");

    let finishSave!: (response: Response) => void;
    let saveStarted!: () => void;
    const saving = new Promise<void>((resolve) => {
      saveStarted = resolve;
    });
    fetch.mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          finishSave = resolve;
          saveStarted();
        })
    );
    const save = controller.command({
      operation: "setEmailUpdates",
      subscribed: true,
      stateRevision: controller.current().revision
    });
    await saving;
    expect(fetch).toHaveBeenLastCalledWith(
      new URL("https://account.example.test/v1/account/email-updates"),
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          subscribed: true,
          expectedRevision: 0,
          email: first.emailUpdates.email,
          noticeVersion: first.emailUpdates.noticeVersion
        })
      })
    );
    await controller.command({ operation: "reportProfileOffline" });
    expect(controller.current().details).toEqual({ status: "unavailable" });
    finishSave(
      Response.json({ ...first.emailUpdates, subscribed: true, revision: 1 })
    );
    await save;
    expect(controller.current()).toMatchObject({
      busy: false,
      details: { status: "unavailable" }
    });
    await controller.command({
      operation: "setEmailUpdates",
      subscribed: true,
      stateRevision: controller.current().revision
    });
    expect(fetch).toHaveBeenCalledTimes(2);

    const afterReconnect = profileDetails(profile.id, "0x0");
    fetch.mockResolvedValueOnce(Response.json(afterReconnect));
    expect(
      await controller.command({ operation: "refreshProfile" })
    ).toMatchObject({
      details: { status: "ready", value: afterReconnect }
    });

    let finishOldRead!: (response: Response) => void;
    let oldReadStarted!: () => void;
    const reading = new Promise<void>((resolve) => {
      oldReadStarted = resolve;
    });
    fetch.mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          finishOldRead = resolve;
          oldReadStarted();
        })
    );
    const oldRead = controller.command({ operation: "refreshProfile" });
    await reading;
    await controller.command({ operation: "signOut" });
    expect(controller.current().details).toBeUndefined();
    await controller.command({ operation: "reportProfileOffline" });
    await controller.command({ operation: "signIn", screen: "sign-in" });
    const second = profileDetails("user_other", "0x0");
    vi.mocked(runtime.callback).mockResolvedValueOnce({
      ...credentials,
      user: { ...credentials.user, id: second.userId }
    });
    vi.mocked(runtime.profile).mockReturnValueOnce({
      ...profile,
      id: second.userId
    });
    fetch.mockResolvedValueOnce(Response.json(second));
    const signIn = controller.callback(
      config.callbackUri + "?code=second&state=proof"
    );
    finishOldRead(Response.json(first));
    await Promise.all([oldRead, signIn]);
    expect(controller.current()).toMatchObject({
      profile: { id: second.userId },
      details: { status: "ready", value: second }
    });
  });
  it("restores a stale signed-in profile offline and recovers without restarting", async () => {
    const { controller, runtime, credentials } = fixture();
    vi.mocked(runtime.getProfile).mockResolvedValue(profile);
    vi.mocked(runtime.read).mockResolvedValue(credentials);
    vi.mocked(runtime.validate).mockRejectedValueOnce(
      new TypeError("private network detail")
    );
    await controller.restore();
    expect(controller.current()).toMatchObject({
      status: "signed_in",
      profile,
      stale: true,
      busy: false,
      messageCode: "operation_failed"
    });
    expect(runtime.clear).not.toHaveBeenCalled();
    await controller.command({ operation: "refreshProfile" });
    expect(controller.current()).toMatchObject({
      status: "signed_in",
      profile,
      stale: false,
      message: null
    });
  });
  it("clears a revoked offline session when refresh returns a terminal failure", async () => {
    const { controller, runtime, credentials } = fixture();
    vi.mocked(runtime.getProfile).mockResolvedValue(profile);
    vi.mocked(runtime.read).mockResolvedValue(credentials);
    vi.mocked(runtime.validate).mockRejectedValueOnce(new Error("offline"));
    await controller.restore();
    const error = new Error("revoked");
    error.name = "TokenValidationError";
    vi.mocked(runtime.validate).mockRejectedValueOnce(error);
    await controller.command({ operation: "refreshProfile" });
    expect(controller.current()).toMatchObject({
      status: "reauthentication_required",
      profile: null,
      stale: false,
      messageCode: "session_expired"
    });
    expect(runtime.clear).toHaveBeenCalled();
  });
  it("does not restore an account when sign-out overtakes a recovery refresh", async () => {
    const { controller, runtime, credentials } = fixture();
    vi.mocked(runtime.getProfile).mockResolvedValue(profile);
    vi.mocked(runtime.read).mockResolvedValue(credentials);
    vi.mocked(runtime.validate).mockRejectedValueOnce(new Error("offline"));
    await controller.restore();
    let release!: (
      value: Awaited<ReturnType<AccountRuntime["validate"]>>
    ) => void;
    vi.mocked(runtime.validate).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const refresh = controller.command({ operation: "refreshProfile" });
    await vi.waitFor(() => expect(runtime.validate).toHaveBeenCalledTimes(2));
    await controller.command({ operation: "signOut" });
    release({ session: credentials, claims: { sub: profile.id } } as Awaited<
      ReturnType<AccountRuntime["validate"]>
    >);
    await refresh;
    expect(controller.current()).toMatchObject({
      status: "signed_out",
      profile: null,
      stale: false
    });
    expect(runtime.save).not.toHaveBeenCalled();
    expect(runtime.setProfile).not.toHaveBeenCalled();
  });
  it("reports secure storage failures without describing them as network errors", async () => {
    const { controller, runtime } = fixture();
    vi.mocked(runtime.getProfile).mockRejectedValueOnce(
      new AccountOperationError(
        "storage_unavailable",
        new Error("private keychain data")
      )
    );
    await controller.restore();
    expect(controller.current()).toMatchObject({
      status: "signed_out",
      messageCode: "storage_unavailable"
    });
    expect(controller.current().message).toContain("Secure account storage");
    expect(JSON.stringify(controller.current())).not.toMatch(
      /WorkOS could not be reached|private keychain/
    );
  });
  it("distinguishes browser launch failure from authentication failures", async () => {
    const { controller, runtime } = fixture();
    vi.mocked(runtime.begin).mockRejectedValueOnce(
      new AccountOperationError("browser_unavailable")
    );
    await controller.command({ operation: "signIn", screen: "sign-in" });
    expect(controller.current()).toMatchObject({
      status: "signed_out",
      messageCode: "browser_unavailable"
    });
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
