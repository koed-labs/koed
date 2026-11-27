import { useState } from "react";
import type {
  AccountDesktopApi,
  AccountState
} from "@koed-labs/shared/account";
import { ThemeStore } from "./renderer/state/theme.js";
import { SidebarValidation } from "./sidebar-validation.js";

// Validation-only view data. This adapter has no provider or network authority.
export function AccountValidation() {
  useState(() => {
    const store = new ThemeStore();
    void store.set(
      new URLSearchParams(location.search).get("theme") === "light"
        ? "light"
        : "dark"
    );
    return store;
  });
  const [account] = useState(() => {
    const scene = new URLSearchParams(location.search).get("account");
    const avatar = new URLSearchParams(location.search).get("avatar");
    const profile = {
      id: "user_validation1",
      displayName: "Alex Example",
      email: "alex@example.test",
      emailVerified: true,
      profilePictureUrl:
        avatar === "picture" || avatar === "broken"
          ? `https://images.workoscdn.com/koed-validation-${avatar}.png`
          : null
    };
    let state: AccountState = {
      status:
        scene === "disabled"
          ? "unavailable"
          : scene === "signed-out"
            ? "signed_out"
            : scene === "signing-in"
              ? "signing_in"
              : "signed_in",
      profile:
        scene === "disabled" || scene === "signed-out" || scene === "signing-in"
          ? null
          : profile,
      stale: scene === "offline",
      busy: scene === "signing-in",
      message:
        scene === "offline"
          ? "Your account could not be reached. Local Personal Memory is still available."
          : null,
      revision: 0
    };
    const listeners = new Set<(value: AccountState) => void>();
    const publish = (patch: Partial<AccountState>) => {
      state = { ...state, ...patch, revision: state.revision + 1 };
      for (const listener of listeners) listener(state);
      return Promise.resolve(state);
    };
    const account: AccountDesktopApi = {
      getState: () => Promise.resolve(state),
      refreshProfile: () => Promise.resolve(state),
      reportProfileOffline: () => Promise.resolve(state),
      setEmailUpdates: () => Promise.resolve(state),
      signIn: () =>
        publish({ status: "signed_in", profile, stale: false, message: null }),
      cancelSignIn: () =>
        publish({ status: "signed_out", profile: null, busy: false }),
      signOut: () =>
        publish({ status: "signed_out", profile: null, stale: false }),
      onStateChanged: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      }
    };
    window.koedDesktop = {
      invoke: async () => null,
      account
    } as unknown as NonNullable<typeof window.koedDesktop>;
    return account;
  });
  return <SidebarValidation accountApi={account} />;
}
