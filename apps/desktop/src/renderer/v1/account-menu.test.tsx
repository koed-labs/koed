// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarProvider } from "@koed-labs/ui";
import type {
  AccountDesktopApi,
  AccountState
} from "@koed-labs/shared/account";
import { AccountPanel } from "./account-panel.js";
import { useAccountState } from "./use-account-state.js";
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
function AccountTestHost({ api }: { api: AccountDesktopApi }) {
  const [expanded, setExpanded] = useState(false);
  const { state, accept } = useAccountState(expanded ? api : undefined, false);
  return (
    <SidebarProvider>
      <AccountMenu api={api} onExpand={() => setExpanded(true)} />
      {expanded && state && (
        <div role="dialog">
          <AccountPanel api={api} state={state} accept={accept} />
        </div>
      )}
    </SidebarProvider>
  );
}
const render = (api: AccountDesktopApi) =>
  act(async () => root.render(<AccountTestHost api={api} />));
const open = () =>
  act(async () => mount.querySelector<HTMLButtonElement>("button")!.click());
const item = (label: string) =>
  [
    ...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')
  ].find((element) => element.textContent?.trim() === label)!;

describe("rail account menu", () => {
  it("shows one Desktop notification for each confirmed email preference change", async () => {
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
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toMatch(
      /Kin items|Cap/
    );
    expect(document.querySelector('[role="checkbox"]')).toBeNull();
    expect(item("Refresh profile")).toBeUndefined();
    expect(
      document.querySelector('[role="dialog"]')?.textContent
    ).not.toContain("Email updates");
    await act(async () => item("Expand").click());
    expect(
      document.querySelector(".v1-account-settings")?.textContent
    ).toContain("Free");
    const preference =
      document.querySelector<HTMLElement>('[role="checkbox"]')!;
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
    const toast = () => document.querySelector(".v1-pm-toast");
    expect(toast()).toBeNull();
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
    expect(toast()?.textContent).toBe("Email updates turned on.");
    expect(document.querySelector(".v1-account-note")).toBeNull();
    await act(async () => preference.click());
    expect(preference.getAttribute("aria-checked")).toBe("true");
    expect(toast()).toBeNull();
    await act(async () =>
      confirm(publish({ details: { status: "ready", value: details } }))
    );
    expect(preference.getAttribute("aria-checked")).toBe("false");
    expect(toast()?.textContent).toBe("Email updates turned off.");
    expect(document.querySelectorAll(".v1-pm-toast")).toHaveLength(1);
    await act(async () =>
      toast()!
        .querySelector<HTMLButtonElement>(
          '[aria-label="Dismiss notification"]'
        )!
        .click()
    );
    expect(toast()).toBeNull();

    const retryMessage =
      "Refresh your profile to confirm your email updates preference.";
    await act(async () => preference.click());
    await act(async () =>
      confirm(
        publish({
          details: { status: "unavailable" },
          message: retryMessage,
          messageCode: "email_updates_unconfirmed"
        })
      )
    );
    expect(toast()?.getAttribute("role")).toBe("alert");
    expect(toast()?.textContent).toContain(retryMessage);
    expect(document.querySelector(".v1-account-note")).toBeNull();
    expect(item("Refresh profile")).toBeDefined();
    expect(item("Sign out")).toBeDefined();
  });

  it("uses the Desktop notification for a manual profile refresh and its errors", async () => {
    const { api, publish } = fixture(signedIn);
    await render(api);
    await open();
    await act(async () => item("Expand").click());
    const toast = () => document.querySelector(".v1-pm-toast");
    const refresh = () => act(async () => item("Refresh profile").click());
    await act(async () => publish({}));
    expect(toast()).toBeNull();

    await refresh();
    expect(toast()?.getAttribute("role")).toBe("status");
    expect(toast()?.textContent).toBe("Profile refreshed.");
    expect(document.querySelector(".v1-account-note")).toBeNull();

    const message = "Secure account storage is unavailable. Try again.";
    vi.mocked(api.refreshProfile).mockImplementationOnce(async () =>
      publish({ stale: true, messageCode: "storage_unavailable", message })
    );
    await refresh();
    expect(toast()?.getAttribute("role")).toBe("alert");
    expect(toast()?.textContent).toContain(message);
    expect(document.querySelector(".v1-account-note")).toBeNull();
    await act(async () => toast()!.querySelector("button")!.click());
    expect(document.body.textContent).not.toContain(message);

    vi.mocked(api.refreshProfile).mockRejectedValueOnce(
      new Error("Bridge unavailable")
    );
    await refresh();
    expect(toast()?.textContent).toContain("Could not refresh your profile.");
    expect(toast()?.getAttribute("role")).toBe("alert");
  });

  it.each([null, "ALEX@example.test"])(
    "shows the email once when the supplied name is %s",
    async (displayName) => {
      const f = fixture({
        ...signedIn,
        profile: { ...signedIn.profile!, displayName }
      });
      await render(f.api);
      await open();
      const identity = document.querySelector(".v1-account-identity")!;
      expect(identity.querySelector("strong")?.textContent?.toLowerCase()).toBe(
        "alex@example.test"
      );
      expect(identity.querySelector("small")).toBeNull();
    }
  );
  it("shows the signed-out invitation with a static Kin and an accessible close button", async () => {
    await render(fixture().api);
    await open();
    const panel = document.querySelector(
      '[role="dialog"][aria-label="Account"]'
    )!;
    expect(panel.textContent).toContain("gain early access to new features 🚀");
    expect(
      panel.querySelector(".v1-account-status .v1-account-kin")
    ).not.toBeNull();
    expect(panel.querySelector('[aria-label="Close account"]')).not.toBeNull();
    expect(panel.querySelector("h2")).toBeNull();
  });
  it("offers retry and sign-out for a cached profile, then sign-in after expiry", async () => {
    const f = fixture({
      ...signedIn,
      stale: true,
      details: { status: "unavailable" }
    });
    await render(f.api);
    await open();
    await act(async () => item("Expand").click());
    expect(document.body.textContent).toContain(
      "Email preferences are unavailable."
    );
    expect(item("Sign out")).toBeDefined();
    expect(document.querySelector('[role="checkbox"]')).toBeNull();
    await act(async () => item("Refresh profile").click());
    expect(f.api.refreshProfile).toHaveBeenCalledOnce();
    await act(async () =>
      f.publish({ ...signedOut, status: "reauthentication_required" })
    );
    expect(document.body.textContent).not.toContain("alex@example.test");
    await act(async () => item("Sign in again").click());
    expect(f.api.signIn).toHaveBeenCalledWith({ screen: "sign-in" });
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
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "Finish signing in"
    );
    expect(item("Cancel sign-in").disabled).toBe(false);
    await act(async () => item("Cancel sign-in").click());
    expect(f.api.cancelSignIn).toHaveBeenCalledOnce();
    // A failed browser launch from the cancelled action must not overwrite the newer state.
    await act(async () =>
      rejectLaunch(new Error("Late browser launch failure"))
    );
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
    expect(
      document.querySelector('[role="dialog"]')?.textContent
    ).not.toContain("Different success wording");
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
    expect(item("Sign in").disabled).toBe(false);
    expect(f.api.signIn).not.toHaveBeenCalled();
    expect(f.api.refreshProfile).not.toHaveBeenCalled();
  });
});
