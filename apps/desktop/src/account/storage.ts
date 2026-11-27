import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { app, safeStorage } from "electron";
import type { Session } from "@workos/authkit-session";
import {
  accountProfileSchema,
  type AccountProfile
} from "@koed-labs/shared/account";
import type { AccountConfig } from "./config.js";
import { AccountOperationError } from "./errors.js";

export type SignupAttempt = { nonce: string; startedAt: number };

export function signupState(state: string, signup: SignupAttempt) {
  return `koed.signup.v1.${signup.nonce}.${state}`;
}

type Pending = {
  state: string;
  expires: number;
  redirectUri?: string;
  signup?: SignupAttempt;
};

function matches(pending: Pending | null, state: string): pending is Pending {
  return (
    !!pending &&
    pending.expires > Date.now() &&
    (pending.state === state ||
      (!!pending.signup &&
        signupState(pending.state, pending.signup) === state))
  );
}

type StoredAccount = {
  session: Session | null;
  password: string;
  pending: Pending | null;
  profile: AccountProfile | null;
};

/** Async OS encryption with serialized file access and immediate local removal. */
export function createAccountStorage(config: AccountConfig) {
  // Retain the existing filename across login modes without copying credentials.
  const scope = createHash("sha256")
    .update(
      JSON.stringify({
        clientId: config.clientId,
        environment: config.environment,
        redirectUri: config.callbackUri
      })
    )
    .digest("hex");
  const file = join(app.getPath("userData"), `koed-account-${scope}.bin`);
  let password: string | undefined;
  let cached: StoredAccount | null = null;
  let epoch = 0;
  let tail: Promise<unknown> = Promise.resolve();

  const assertSecure = async () => {
    if (
      !(await safeStorage.isAsyncEncryptionAvailable()) ||
      (process.platform === "linux" &&
        safeStorage.getSelectedStorageBackend() === "basic_text")
    )
      throw new Error("Account secure storage is unavailable");
  };
  const write = async (data: StoredAccount, assertCurrent: () => void) => {
    assertCurrent();
    await assertSecure();
    assertCurrent();
    const encrypted = await safeStorage.encryptStringAsync(
      JSON.stringify(data)
    );
    // No await between this guard and rename: sign-out cannot be overtaken by a late write.
    assertCurrent();
    const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      writeFileSync(temporary, encrypted, { mode: 0o600, flag: "wx" });
      renameSync(temporary, file);
      cached = data;
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  };
  const read = async (assertCurrent: () => void): Promise<StoredAccount> => {
    await assertSecure();
    assertCurrent();
    if (!existsSync(file))
      return {
        session: null,
        password: (password ??= randomBytes(32).toString("base64url")),
        pending: null,
        profile: null
      };
    const decrypted = await safeStorage.decryptStringAsync(readFileSync(file));
    assertCurrent();
    const data = JSON.parse(decrypted.result) as StoredAccount;
    password = data.password;
    const incompatible =
      data.pending && data.pending.redirectUri !== config.redirectUri;
    if (incompatible) data.pending = null;
    if (incompatible || decrypted.shouldReEncrypt)
      await write(data, assertCurrent);
    assertCurrent();
    cached = data;
    return data;
  };
  const transaction = <T>(
    operation: (data: StoredAccount, assertCurrent: () => void) => Promise<T>
  ): Promise<T> => {
    const version = epoch;
    const assertCurrent = () => {
      if (version !== epoch)
        throw new Error("Account storage operation was cancelled");
    };
    const work = tail
      .then(async () => {
        assertCurrent();
        const data = await read(assertCurrent);
        assertCurrent();
        return operation(data, assertCurrent);
      })
      .catch((error) => {
        throw new AccountOperationError("storage_unavailable", error);
      });
    tail = work.catch(() => undefined);
    return work;
  };

  return {
    read: () => transaction(async (data) => data.session),
    getProfile: () =>
      transaction(async (data) =>
        data.profile ? accountProfileSchema.parse(data.profile) : null
      ),
    save: (session: Session) =>
      transaction(async (data, current) => {
        data.session = session;
        await write(data, current);
      }),
    setProfile: (profile: AccountProfile) =>
      transaction(async (data, current) => {
        data.profile = accountProfileSchema.parse(profile);
        await write(data, current);
      }),
    cookiePassword: () =>
      transaction(async (data, current) => {
        await write(data, current);
        return data.password;
      }),
    setPending: (state: string, signup?: SignupAttempt) =>
      transaction(async (data, current) => {
        data.pending = {
          state,
          signup,
          expires: Date.now() + 600000,
          redirectUri: config.redirectUri
        };
        await write(data, current);
      }),
    hasPending: (state: string) =>
      transaction(async (data) => matches(data.pending, state)),
    takePending: (state: string) =>
      transaction(async (data, current) => {
        const pending = data.pending;
        if (!matches(pending, state)) return null;
        data.pending = null;
        await write(data, current);
        return pending;
      }),
    clear() {
      const session = cached?.session ?? null;
      epoch++;
      cached = null;
      // Clearing does not wait for a keychain prompt or permit an older write to revive the file.
      try {
        if (existsSync(file)) unlinkSync(file);
      } catch {
        throw new AccountOperationError("storage_unavailable");
      }
      return session;
    }
  };
}
