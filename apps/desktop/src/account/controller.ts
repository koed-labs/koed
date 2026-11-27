import { createHash } from "node:crypto";
import {
  accountStateSchema,
  type AccountCommand,
  type AccountMessageCode,
  type AccountState
} from "@koed-labs/shared/account";
import type { AccountConfig } from "./config.js";
import type { AccountRuntime } from "./runtime.js";
import type { SignupAttempt } from "./storage.js";
import { AccountOperationError } from "./errors.js";
import { createAccountProfileApi } from "./profile-api.js";

const messages: Record<AccountMessageCode, string> = {
  configuration_invalid:
    "Account configuration is invalid. Restart Desktop without a WorkOS API key in its environment.",
  storage_unavailable: "Secure account storage is unavailable. Try again.",
  browser_unavailable: "The sign-in browser did not open. Try again.",
  operation_failed:
    "The account action failed. Try again. Local Personal Memory remains available.",
  session_expired: "Sign in again to refresh your account.",
  sign_out_complete:
    "Signed out on this device. Complete browser sign-out if prompted.",
  sign_out_failed:
    "Secure account storage could not be cleared. Retry sign-out.",
  browser_sign_out_failed:
    "Signed out on this device. WorkOS browser sign-out could not be opened.",
  sign_in_expired: "Sign-in expired. Try again when you are ready.",
  sign_in_failed: "Sign-in did not complete. Try again when you are ready.",
  email_updates_unconfirmed:
    "Refresh your profile to confirm your email updates preference."
};

export function createAccountController(input: {
  config: AccountConfig | null;
  runtime: () => AccountRuntime;
}) {
  let state: AccountState = {
    status: input.config ? "restoring" : "unavailable",
    profile: null,
    stale: false,
    busy: false,
    messageCode: null,
    message: null,
    revision: 0
  };
  const isSigningIn = () => state.status === "signing_in";
  let generation = 0;
  let profileEpoch = 0;
  let profileConnected = true;
  let signInDeadline: ReturnType<typeof setTimeout> | undefined;
  const stopDeadline = () => {
    clearTimeout(signInDeadline);
    signInDeadline = undefined;
  };
  let runtime: AccountRuntime | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  const listeners = new Set<(state: AccountState) => void>();
  const profileApi = input.config?.profileApiOrigin
    ? createAccountProfileApi(input.config.profileApiOrigin)
    : undefined;
  const publish = (patch: Partial<AccountState>) => {
    const next = {
      ...state,
      ...patch,
      ...(patch.messageCode !== undefined
        ? {
            message: patch.messageCode ? messages[patch.messageCode] : null
          }
        : {}),
      revision: state.revision + 1
    };
    if (
      next.status !== "signed_in" ||
      next.stale ||
      next.profile?.id !== state.profile?.id
    ) {
      delete next.details;
    }
    state = accountStateSchema.parse(next);
    for (const listener of listeners) listener(state);
    return state;
  };
  const sdk = () => (runtime ??= input.runtime());
  const isCurrentProfile = (userId: string, version: number) =>
    generation === version &&
    state.status === "signed_in" &&
    !state.stale &&
    state.profile?.id === userId;
  const refreshDetails = async (
    userId: string,
    accessToken: string,
    version: number,
    optIn?: { attempt: SignupAttempt; proof: string; email: string }
  ) => {
    if (!profileApi) return;
    if (!isCurrentProfile(userId, version)) return;
    if (!profileConnected) {
      publish({ details: { status: "unavailable" } });
      return;
    }
    const epoch = profileEpoch;
    const current = () =>
      epoch === profileEpoch && isCurrentProfile(userId, version);
    publish({ details: { status: "loading" } });
    try {
      const value = await profileApi.getProfile(accessToken, userId);
      if (
        optIn &&
        current() &&
        value.emailUpdates.revision === 0 &&
        value.emailUpdates.email === optIn.email
      ) {
        const { noticeVersion, noticeText } = value.emailUpdates;
        const proof = createHash("sha256")
          .update(
            JSON.stringify([optIn.attempt.nonce, noticeVersion, noticeText])
          )
          .digest("hex");
        if (proof === optIn.proof) {
          value.emailUpdates = await profileApi.recordSignupOptIn(
            accessToken,
            value.emailUpdates
          );
        }
      }
      if (current()) publish({ details: { status: "ready", value } });
    } catch {
      if (current())
        publish({
          details: { status: "unavailable" },
          ...(optIn && { messageCode: "email_updates_unconfirmed" as const })
        });
    }
  };
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
        : state.profile
          ? "signed_in"
          : "signed_out",
      profile: terminal ? null : state.profile,
      stale: !terminal && !!state.profile,
      busy: false,
      messageCode: terminal
        ? "session_expired"
        : error instanceof AccountOperationError
          ? error.code
          : "operation_failed"
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
          publish({
            status: "signed_out",
            profile: null,
            stale: false,
            busy: false,
            messageCode: null
          });
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
          messageCode: null
        });
        await refreshDetails(
          profile.id,
          validated.session.accessToken,
          version
        );
      }
    } catch (error) {
      fail(error, version);
    }
    return state;
  };
  const command = async (command: AccountCommand): Promise<AccountState> => {
    if (command.operation === "getState") return state;
    if (!input.config) return state;
    if (command.operation === "reportProfileOffline") {
      if (!profileApi || !profileConnected) return state;
      profileConnected = false;
      profileEpoch++;
      if (state.status === "signed_in") {
        return publish({ details: { status: "unavailable" } });
      }
      return state;
    }
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
        messageCode: null
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
          messageCode: "sign_out_failed"
        });
      }
      const version = generation;
      publish({
        status: "signed_out",
        profile: null,
        stale: false,
        busy: false,
        messageCode: null
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
            messageCode: opened
              ? "sign_out_complete"
              : "browser_sign_out_failed"
          });
      }
      return state;
    }
    if (command.operation === "signIn") {
      if (state.status === "signed_in" || state.status === "signing_in")
        return state;
      const version = ++generation;
      profileConnected = true;
      publish({
        status: "signing_in",
        profile: null,
        stale: false,
        busy: true,
        messageCode: null
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
              messageCode: "sign_in_expired"
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
    if (command.operation === "setEmailUpdates") {
      const version = generation;
      const epoch = profileEpoch;
      const snapshot =
        state.details?.status === "ready" ? state.details.value : null;
      if (
        !profileApi ||
        !profileConnected ||
        !snapshot ||
        state.revision !== command.stateRevision ||
        state.busy ||
        !isCurrentProfile(snapshot.userId, version)
      )
        return state;
      const current = () =>
        epoch === profileEpoch && isCurrentProfile(snapshot.userId, version);
      publish({ busy: true, messageCode: null });
      await serial(async () => {
        try {
          if (!current()) return;
          const session = await sdk().read();
          if (!current()) return;
          if (!session || session.user.id !== snapshot.userId) {
            throw new Error("Account session changed");
          }
          const validated = await sdk().validate(session);
          if (!isCurrentProfile(snapshot.userId, version)) return;
          if (sdk().profile(validated).id !== snapshot.userId) {
            throw new Error("Account session changed");
          }
          // Going offline cancels the preference update, but the same account
          // still needs its rotated refresh token for the next connection.
          if (validated.refreshed) await sdk().save(validated.session);
          if (!current()) return;
          const emailUpdates = await profileApi.setEmailUpdates(
            validated.session.accessToken,
            command.subscribed,
            snapshot.emailUpdates
          );
          if (current())
            publish({
              busy: false,
              details: {
                status: "ready",
                value: { ...snapshot, emailUpdates }
              }
            });
        } catch {
          if (current())
            publish({
              busy: false,
              details: { status: "unavailable" },
              messageCode: "email_updates_unconfirmed"
            });
        } finally {
          if (
            epoch !== profileEpoch &&
            isCurrentProfile(snapshot.userId, version) &&
            state.busy
          ) {
            publish({ busy: false });
          }
        }
      });
      return state;
    }
    const version = generation;
    profileConnected = true;
    publish({ busy: true, messageCode: null });
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
              messageCode: "sign_in_failed"
            });
            return;
          }
          const code = url.searchParams.get("code"),
            sealedState = url.searchParams.get("state");
          if (!code || !sealedState)
            throw new Error("Invalid sign-in response");
          const { signup, ...session } = await sdk().callback(
            code,
            sealedState
          );
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
            messageCode: null
          });
          const proofs = url.searchParams.getAll("signup_opt_in");
          const createdAt = profile.joinedAt
            ? Date.parse(profile.joinedAt)
            : NaN;
          await refreshDetails(
            profile.id,
            validated.session.accessToken,
            version,
            signup &&
              createdAt >= signup.startedAt &&
              createdAt <= Date.now() &&
              proofs.length === 1 &&
              /^[a-f0-9]{64}$/.test(proofs[0]!)
              ? { attempt: signup, proof: proofs[0]!, email: profile.email }
              : undefined
          );
        } catch (error) {
          fail(error, version);
        }
      });
      return true;
    }
  };
}
export type AccountController = ReturnType<typeof createAccountController>;
