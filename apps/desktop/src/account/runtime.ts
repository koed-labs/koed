import { randomBytes } from "node:crypto";
import {
  AuthKitCore,
  AuthOperations,
  sessionEncryption,
  type AuthKitPublicConfig,
  type Session
} from "@workos/authkit-session";
import { createWorkOS, type WorkOS } from "@workos-inc/node";
import {
  accountProfileSchema,
  accountProfilePictureUrlSchema
} from "@koed-labs/shared/account";
import type { AccountConfig } from "./config.js";
import {
  createAccountStorage,
  signupState,
  type SignupAttempt
} from "./storage.js";
import { AccountOperationError } from "./errors.js";

export function createAccountRuntime(
  config: AccountConfig,
  openExternal: (url: string) => Promise<unknown>
) {
  const storage = createAccountStorage(config);
  let sdk:
    | { core: AuthKitCore; operations: AuthOperations; client: WorkOS }
    | undefined;
  const provider = async () => {
    if (!sdk) {
      // The pinned SDK inherits this key even through its public factory.
      // Check immediately before construction, without changing global state.
      if (process.env.WORKOS_API_KEY !== undefined)
        throw new AccountOperationError("configuration_invalid");
      // Core types a full WorkOS client but uses only public operations here.
      const client = createWorkOS({
        clientId: config.clientId
      }) as unknown as WorkOS;
      const password = await storage.cookiePassword();
      if (!sdk) {
        const sdkConfig: AuthKitPublicConfig = {
          clientId: config.clientId,
          redirectUri: config.redirectUri,
          cookiePassword: password,
          cookieName: "wos-session",
          cookieMaxAge: 60 * 60 * 24 * 400,
          apiHttps: true
        };
        const core = new AuthKitCore(sdkConfig, client, sessionEncryption);
        sdk = {
          client,
          core,
          operations: new AuthOperations(
            core,
            client,
            sdkConfig,
            sessionEncryption
          )
        };
      }
    }
    return sdk;
  };

  return {
    async begin(screenHint: "sign-in" | "sign-up", isCurrent: () => boolean) {
      const { operations } = await provider();
      if (!isCurrent()) return;
      const { url, sealedState } = await operations.createAuthorization({
        screenHint
      });

      if (!isCurrent()) return;
      const signup =
        screenHint === "sign-up" &&
        config.loginMode === "forwarder" &&
        config.profileApiOrigin
          ? {
              nonce: randomBytes(32).toString("base64url"),
              startedAt: Date.now()
            }
          : undefined;
      const authorization = new URL(url);
      if (signup)
        authorization.searchParams.set(
          "state",
          signupState(sealedState, signup)
        );
      await storage.setPending(sealedState, signup);
      if (isCurrent()) {
        try {
          await openExternal(authorization.href);
        } catch (error) {
          throw new AccountOperationError("browser_unavailable", error);
        }
      }
    },
    hasPending: storage.hasPending,
    cancel: () => {
      storage.clear();
    },
    getProfile: storage.getProfile,
    setProfile: storage.setProfile,
    async callback(
      code: string,
      state: string
    ): Promise<Session & { signup?: SignupAttempt }> {
      const stored = await storage.takePending(state);
      if (!stored) throw new Error("Sign-in attempt expired");
      const { core, client } = await provider();
      const { codeVerifier } = await core.verifyCallbackState({
        stateFromUrl:
          stored.signup && state !== stored.state
            ? state.slice(signupState("", stored.signup).length)
            : state,
        cookieValue: stored.state
      });
      // The pinned public SDK accepts clientId/code/codeVerifier, not redirectUri.
      // WorkOS binds the code to the HTTPS redirect in the authorization request.
      const result = await client.userManagement.authenticateWithCode({
        clientId: config.clientId,
        code,
        codeVerifier
      });
      return {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        user: result.user,
        impersonator: result.impersonator,
        // Older forwarders echo the whole envelope. They never showed a checkbox.
        signup: state === stored.state ? stored.signup : undefined
      };
    },
    read: storage.read,
    save: storage.save,
    clear: storage.clear,
    async validate(session: Session, force = false) {
      try {
        const { core } = await provider();
        return await core.validateAndRefresh(session, { force });
      } catch (error) {
        let cause: unknown = error;
        for (
          let depth = 0;
          depth < 4 && cause && typeof cause === "object";
          depth++
        ) {
          if (
            ("error" in cause && cause.error === "invalid_grant") ||
            ("code" in cause && cause.code === "invalid_grant")
          ) {
            const expired = new Error("Sign in again to continue");
            expired.name = "TokenValidationError";
            throw expired;
          }
          cause = "cause" in cause ? cause.cause : null;
        }
        throw error;
      }
    },
    profile(validated: Awaited<ReturnType<AuthKitCore["validateAndRefresh"]>>) {
      const { session, claims } = validated;
      if (claims.sub !== session.user.id || !session.user.emailVerified) {
        const error = new Error("Verified WorkOS identity required");
        error.name = "TokenValidationError";
        throw error;
      }
      const picture = accountProfilePictureUrlSchema.safeParse(
        session.user.profilePictureUrl
      );
      const displayName =
        session.user.name?.trim() ||
        [session.user.firstName, session.user.lastName]
          .map((part) => part?.trim())
          .filter(Boolean)
          .join(" ");
      const joinedAt = accountProfileSchema.shape.joinedAt.safeParse(
        session.user.createdAt
      );
      return accountProfileSchema.parse({
        joinedAt: joinedAt.success ? joinedAt.data : undefined,
        id: session.user.id,
        displayName: displayName.slice(0, 100) || null,
        email: session.user.email,
        emailVerified: session.user.emailVerified,
        profilePictureUrl: picture.success ? picture.data : null
      });
    },
    async end(session: Session) {
      const { core, operations } = await provider();
      const claims = core.parseTokenClaims(session.accessToken);
      await openExternal(operations.getLogoutUrl(claims.sid));
    }
  };
}
export type AccountRuntime = ReturnType<typeof createAccountRuntime>;
