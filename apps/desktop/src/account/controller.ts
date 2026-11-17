import {
  accountStateSchema,
  type AccountCommand,
  type AccountState
} from "@koed-labs/shared/account";
import type { AccountConfig } from "./config.js";
import type { AccountRuntime } from "./runtime.js";

export function createAccountController(input: {
  config: AccountConfig | null;
  runtime: () => AccountRuntime;
}) {
  let state: AccountState = {
    status: input.config ? "restoring" : "unavailable",
    profile: null,
    stale: false,
    busy: false,
    message: null,
    revision: 0
  };
  const isSigningIn = () => state.status === "signing_in";
  let generation = 0;
  let signInDeadline: ReturnType<typeof setTimeout> | undefined;
  const stopDeadline = () => {
    clearTimeout(signInDeadline);
    signInDeadline = undefined;
  };
  let runtime: AccountRuntime | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  const listeners = new Set<(state: AccountState) => void>();
  const publish = (patch: Partial<AccountState>) => {
    state = accountStateSchema.parse({
      ...state,
      ...patch,
      revision: state.revision + 1
    });
    for (const listener of listeners) listener(state);
    return state;
  };
  const sdk = () => (runtime ??= input.runtime());
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const work = tail.then(operation, operation);
    tail = work.catch(() => undefined);
    return work;
  };
  const fail = (error: unknown, version: number) => {
    if (version !== generation) return state;
    const terminal =
      error instanceof Error &&
      ["TokenValidationError", "InvalidGrantError"].includes(error.name);
    if (terminal) {
      try {
        runtime?.clear();
      } catch {
        // Authorization loss still clears visible state if the key store fails.
      }
    }
    return publish({
      status: terminal
        ? "reauthentication_required"
        : state.status === "signing_in" || state.status === "restoring"
          ? "signed_out"
          : state.status,
      profile: terminal ? null : state.profile,
      stale: !terminal && !!state.profile,
      busy: false,
      message: terminal
        ? "Sign in again to refresh your account."
        : "WorkOS could not be reached. Local Personal Memory is still available."
    });
  };
  const refresh = async (version: number) => {
    try {
      if (version !== generation) return state;
      const cached = await sdk().getProfile();
      if (version !== generation) return state;
      if (!state.profile && cached && version === generation)
        publish({ profile: cached, stale: true });
      const session = await sdk().read();
      if (version !== generation) return state;
      if (!session) {
        if (version === generation)
          publish({ status: "signed_out", profile: null, busy: false });
        return state;
      }
      const validated = await sdk().validate(session, true);
      if (version !== generation) return state;
      const profile = sdk().profile(validated);
      await sdk().save(validated.session);
      if (version !== generation) return state;
      await sdk().setProfile(profile);
      if (version === generation) {
        publish({
          status: "signed_in",
          profile,
          stale: false,
          busy: false,
          message: null
        });
      }
    } catch (error) {
      fail(error, version);
    }
    return state;
  };
  const command = async (command: AccountCommand): Promise<AccountState> => {
    if (command.operation === "getState") return state;
    if (!input.config) return state;
    if (command.operation === "cancelSignIn") {
      if (!isSigningIn()) return state;
      stopDeadline();
      generation++;
      try {
        runtime?.cancel();
      } catch {
        // The generation guard also rejects a cancelled callback.
      }
      return publish({
        status: "signed_out",
        profile: null,
        busy: false,
        message: null
      });
    }
    if (command.operation === "signOut") {
      stopDeadline();
      generation++;
      let session;
      try {
        session = sdk().clear();
      } catch {
        return publish({
          status: "reauthentication_required",
          profile: null,
          busy: false,
          message:
            "Secure account storage could not be cleared. Retry sign-out."
        });
      }
      const version = generation;
      publish({
        status: "signed_out",
        profile: null,
        stale: false,
        busy: false,
        message: null
      });
      if (session) {
        let opened = false;
        try {
          await sdk().end(session);
          opened = true;
        } catch {
          /* Local sign-out is complete even if the browser cannot open. */
        }
        if (version === generation)
          publish({
            message: opened
              ? "Signed out on this device. Complete browser sign-out if prompted."
              : "Signed out on this device. WorkOS browser sign-out could not be opened."
          });
      }
      return state;
    }
    if (command.operation === "signIn") {
      if (state.status === "signed_in" || state.status === "signing_in")
        return state;
      const version = ++generation;
      publish({
        status: "signing_in",
        profile: null,
        stale: false,
        busy: true,
        message: null
      });
      try {
        sdk().clear();
        await sdk().begin(command.screen, () => version === generation);
        if (version === generation && isSigningIn()) {
          stopDeadline();
          signInDeadline = setTimeout(() => {
            if (version !== generation || !isSigningIn()) return;
            generation++;
            try {
              sdk().cancel();
            } catch {
              /* Generation invalidation still prevents this process accepting the attempt. */
            }
            publish({
              status: "signed_out",
              profile: null,
              busy: false,
              message: "Sign-in expired. Try again when you are ready."
            });
          }, 600000);
          signInDeadline.unref();
        }
      } catch (error) {
        fail(error, version);
      }
      return state;
    }
    if (isSigningIn()) return state;
    const version = generation;
    publish({ busy: true, message: null });
    return serial(() => refresh(version));
  };
  return {
    current: () => state,
    subscribe(listener: (state: AccountState) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    command,
    restore: () => {
      const version = generation;
      return input.config
        ? serial(() => refresh(version))
        : Promise.resolve(state);
    },
    async callback(value: string) {
      if (!input.config) return false;
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return false;
      }
      const expected = new URL(input.config.callbackUri);
      if (
        url.protocol !== expected.protocol ||
        url.host !== expected.host ||
        url.pathname !== expected.pathname ||
        url.username ||
        url.password ||
        url.hash ||
        url.searchParams.getAll("state").length !== 1 ||
        url.searchParams.getAll("code").length > 1 ||
        url.searchParams.getAll("error").length > 1 ||
        url.searchParams.has("code") === url.searchParams.has("error") ||
        !url.searchParams.get("state") ||
        !(url.searchParams.get("code") || url.searchParams.get("error")) ||
        value.length > 16384
      )
        return false;
      try {
        if (!(await sdk().hasPending(url.searchParams.get("state") ?? "")))
          return true;
      } catch {
        return true;
      }

      const version = generation;
      await serial(async () => {
        try {
          if (
            version !== generation ||
            !(await sdk().hasPending(url.searchParams.get("state") ?? ""))
          )
            return;
          if (version !== generation) return;
          stopDeadline();
          if (url.searchParams.has("error")) {
            sdk().cancel();
            publish({
              status: "signed_out",
              profile: null,
              stale: false,
              busy: false,
              message: "Sign-in did not complete. Try again when you are ready."
            });
            return;
          }
          const code = url.searchParams.get("code"),
            sealedState = url.searchParams.get("state");
          if (!code || !sealedState)
            throw new Error("Invalid sign-in response");
          const session = await sdk().callback(code, sealedState);
          if (version !== generation) return;
          const validated = await sdk().validate(session);
          const profile = sdk().profile(validated);
          if (version !== generation) return;
          await sdk().save(validated.session);
          if (version !== generation) return;
          await sdk().setProfile(profile);
          if (version !== generation) return;
          publish({
            status: "signed_in",
            profile,
            stale: false,
            busy: false,
            message: null
          });
        } catch (error) {
          fail(error, version);
        }
      });
      return true;
    }
  };
}
export type AccountController = ReturnType<typeof createAccountController>;
