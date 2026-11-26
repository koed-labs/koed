// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarProvider } from "@koed-labs/ui";
import type {
  AccountDesktopApi,
  AccountState
} from "@koed-labs/shared/account";
import { AccountMenu } from "./account-menu.js";

const signedOut: AccountState = {
  status: "signed_out",
  profile: null,
  stale: false,
  busy: false,
  message: null,
  revision: 0
};
const signedIn: AccountState = {
  ...signedOut,
  status: "signed_in",
  revision: 1,
  profile: {
    id: "user_alex",
    displayName: "Alex Example",
    email: "alex@example.test",
    emailVerified: true,
    profilePictureUrl: "https://images.workoscdn.com/alex.png"
  }
};
function fixture(initial = signedOut) {
  let state = initial;
  const listeners = new Set<(next: AccountState) => void>();
  const publish = (patch: Partial<AccountState>) => {
    state = { ...state, ...patch, revision: state.revision + 1 };
    for (const listener of listeners) listener(state);
    return state;
  };
  const api: AccountDesktopApi = {
    getState: vi.fn(async () => state),
    signIn: vi.fn(async () => publish({ status: "signing_in", busy: true })),
    cancelSignIn: vi.fn(async () =>
      publish({ ...signedOut, revision: state.revision })
    ),
    signOut: vi.fn(async () =>
      publish({ ...signedOut, revision: state.revision })
    ),
    refreshProfile: vi.fn(async () => state),
    reportProfileOffline: vi.fn(async () => state),
    setEmailUpdates: vi.fn(async () => state),
    onStateChanged: vi.fn((listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    })
  };
  return { api, publish, listeners };
}
let root: Root;
let mount: HTMLDivElement;
beforeEach(() => {
  mount = document.createElement("div");
  document.body.append(mount);
  root = createRoot(mount);
});
afterEach(async () => {
  await act(async () => root.unmount());
  mount.remove();
});
const render = (api: AccountDesktopApi) =>
  act(async () =>
    root.render(
      <SidebarProvider>
        <AccountMenu api={api} />
      </SidebarProvider>
    )
  );
const open = () =>
  act(async () => mount.querySelector<HTMLButtonElement>("button")!.click());
const item = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (element) => element.textContent?.trim() === label
  )!;

describe("rail account menu", () => {
  it("shows the confirmed email preference and changes it only after the save returns", async () => {
    const details = {
      userId: signedIn.profile!.id,
      emailUpdates: {
        email: "updates@example.test",
        subscribed: false,
        revision: 0,
        noticeVersion: "fixture-v1",
        noticeText: "Send me synthetic product updates."
      },
      kin: { unlockMask: "0x1", catalogVersion: "1.1.0" }
    };
    const { api, publish } = fixture({
      ...signedIn,
      details: { status: "ready", value: details }
    });
    let confirm!: (state: AccountState) => void;
    vi.mocked(api.setEmailUpdates).mockImplementation(
      () =>
        new Promise((resolve) => {
          confirm = resolve;
        })
    );
    await render(api);
    await open();
    expect(document.querySelector('[role="menu"]')?.textContent).not.toMatch(
      /Kin items|Cap/
    );
    const preference = document.querySelector<HTMLElement>(
      '[role="menuitemcheckbox"]'
    )!;
    expect(preference.getAttribute("aria-checked")).toBe("false");
    expect(
      document.getElementById(preference.getAttribute("aria-describedby")!)
        ?.textContent
    ).toContain(details.emailUpdates.email);
    await act(async () => preference.click());
    expect(api.setEmailUpdates).toHaveBeenCalledWith({
      subscribed: true,
      stateRevision: signedIn.revision
    });
    expect(preference.getAttribute("aria-checked")).toBe("false");
    await act(async () =>
      confirm(
        publish({
          details: {
            status: "ready",
            value: {
              ...details,
              emailUpdates: {
                ...details.emailUpdates,
                subscribed: true,
                revision: 1
              }
            }
          }
        })
      )
    );
    expect(preference.getAttribute("aria-checked")).toBe("true");
  });

  it("stays hidden until availability resolves and while main disables accounts", async () => {
    const f = fixture({ ...signedOut, status: "unavailable" });
    let resolveRead!: (value: AccountState) => void;
    vi.mocked(f.api.getState).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        })
    );
    await render(f.api);
    expect(mount.querySelector("button")).toBeNull();
    await act(async () => resolveRead({ ...signedOut, status: "unavailable" }));
    expect(mount.querySelector("li")).toBeNull();
    expect(f.api.signIn).not.toHaveBeenCalled();
    expect(f.api.refreshProfile).not.toHaveBeenCalled();
    await act(async () => f.publish(signedOut));
    expect(mount.querySelector("button")).not.toBeNull();
    await act(async () => f.publish({ status: "unavailable" }));
    expect(mount.querySelector("button")).toBeNull();
  });
  it("starts sign-in only on request and allows cancellation while launch is pending", async () => {
    const f = fixture();
    let rejectLaunch!: (reason: Error) => void;
    vi.mocked(f.api.signIn).mockImplementation(() => {
      f.publish({ status: "signing_in", busy: true });
      return new Promise((_, reject) => {
        rejectLaunch = reject;
      });
    });
    await render(f.api);
    expect(f.api.signIn).not.toHaveBeenCalled();
    expect(f.api.refreshProfile).not.toHaveBeenCalled();
    await open();
    await act(async () => item("Sign in").click());
    expect(f.api.signIn).toHaveBeenCalledWith({ screen: "sign-in" });
    await open();
    expect(document.querySelector('[role="menu"]')?.textContent).toContain(
      "Finish sign-in in your browser"
    );
    expect(item("Cancel sign-in").getAttribute("aria-disabled")).not.toBe(
      "true"
    );
    await act(async () => item("Cancel sign-in").click());
    expect(f.api.cancelSignIn).toHaveBeenCalledOnce();
    // A failed browser launch from the cancelled action must not overwrite the newer state.
    await act(async () =>
      rejectLaunch(new Error("Late browser launch failure"))
    );
    await open();
    expect(item("Sign in")).toBeDefined();
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it("ignores an older state read and clears the visible identity on sign-out", async () => {
    const f = fixture();
    let resolveRead!: (value: AccountState) => void;
    vi.mocked(f.api.getState).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        })
    );
    await render(f.api);
    await act(async () => f.publish({ ...signedIn, revision: 4 }));
    await act(async () => resolveRead(signedOut));
    expect(mount.querySelector("button")?.getAttribute("aria-label")).toContain(
      "Alex Example"
    );
    const image = mount.querySelector<HTMLImageElement>("img")!;
    expect(image.referrerPolicy).toBe("no-referrer");
    await act(async () => image.dispatchEvent(new Event("error")));
    expect(mount.querySelector(".v1-account-avatar")?.textContent).toBe("AE");
    await open();
    await act(async () => item("Sign out").click());
    expect(f.api.signOut).toHaveBeenCalledOnce();
    expect(mount.querySelector("button")?.getAttribute("aria-label")).toBe(
      "Account menu: Account"
    );
    expect(mount.querySelector("img")).toBeNull();
    expect(mount.textContent).not.toContain("AE");
    await act(async () => root.unmount());
    expect(f.listeners.size).toBe(0);
    root = createRoot(mount);
  });

  it("hides successful sign-out by code and preserves sign-out errors", async () => {
    const f = fixture({
      ...signedOut,
      messageCode: "sign_out_complete",
      message: "Different success wording"
    });
    await render(f.api);
    await open();
    expect(document.querySelector('[role="menu"]')?.textContent).not.toContain(
      "Different success wording"
    );
    await act(async () =>
      f.publish({
        messageCode: "browser_sign_out_failed",
        message: "Browser logout failed"
      })
    );
    expect(document.body.textContent).toContain("Browser logout failed");
  });
  it("keeps unknown availability hidden after a bridge failure and retries the local read on focus", async () => {
    const f = fixture();
    vi.mocked(f.api.getState).mockRejectedValueOnce(
      new Error("Bridge unavailable")
    );
    await render(f.api);
    expect(mount.querySelector("button")).toBeNull();
    await act(async () => window.dispatchEvent(new Event("focus")));
    await open();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(item("Sign in").getAttribute("aria-disabled")).not.toBe("true");
    expect(f.api.signIn).not.toHaveBeenCalled();
    expect(f.api.refreshProfile).not.toHaveBeenCalled();
  });
});
