// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  AccountDesktopApi,
  AccountState
} from "@koed-labs/shared/account";
import { useAccountState } from "./use-account-state.js";

const cached: AccountState = {
  status: "signed_in",
  stale: true,
  busy: false,
  message: null,
  revision: 1,
  profile: {
    id: "user_test",
    displayName: "Alex",
    email: "alex@example.test",
    emailVerified: true
  }
};
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
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function fixture(initial = cached) {
  let state = initial;
  const listeners = new Set<(state: AccountState) => void>();
  const publish = (patch: Partial<AccountState>) => {
    state = { ...state, ...patch, revision: state.revision + 1 };
    for (const listener of listeners) listener(state);
    return state;
  };
  const api: AccountDesktopApi = {
    getState: vi.fn(async () => state),
    refreshProfile: vi.fn(async () => state),
    reportProfileOffline: vi.fn(async () => state),
    setEmailUpdates: vi.fn(async () => state),
    signIn: vi.fn(async () => state),
    signOut: vi.fn(async () => state),
    cancelSignIn: vi.fn(async () => state),
    onStateChanged: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
  function Probe() {
    const { state: current } = useAccountState(api);
    return (
      <div>
        {current?.status}:{String(current?.stale)}
      </div>
    );
  }
  return {
    api,
    publish,
    render: () => act(async () => root.render(<Probe />))
  };
}
it("retries a cached account on focus or online, with one trailing request per throttle window", async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.render();
  expect(f.api.refreshProfile).not.toHaveBeenCalled();
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(f.api.refreshProfile).toHaveBeenCalledTimes(1);
  await act(async () => {
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("focus"));
  });
  expect(f.api.refreshProfile).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(30000));
  expect(f.api.refreshProfile).toHaveBeenCalledTimes(2);
  // A failed request does not create a polling loop without another event.
  await act(async () => vi.advanceTimersByTimeAsync(60000));
  expect(f.api.refreshProfile).toHaveBeenCalledTimes(2);
  vi.mocked(f.api.refreshProfile).mockImplementationOnce(async () =>
    f.publish({ stale: false, message: null })
  );
  await act(async () => window.dispatchEvent(new Event("online")));
  expect(mount.textContent).toBe("signed_in:false");
});
it.each([
  "unavailable",
  "signed_out",
  "signing_in",
  "reauthentication_required"
] as const)(
  "never refreshes %s accounts after focus or online",
  async (status) => {
    const f = fixture({ ...cached, status, profile: null });
    await f.render();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("online"));
    });
    expect(f.api.refreshProfile).not.toHaveBeenCalled();
    expect(f.api.signIn).not.toHaveBeenCalled();
  }
);
it("does not revive a cached identity from a late read after sign-out", async () => {
  const f = fixture();
  await f.render();
  let resolve!: (state: AccountState) => void;
  vi.mocked(f.api.getState).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  await act(async () => window.dispatchEvent(new Event("focus")));
  await act(async () =>
    f.publish({ status: "signed_out", profile: null, stale: false })
  );
  await act(async () => resolve(cached));
  expect(f.api.refreshProfile).not.toHaveBeenCalled();
  expect(mount.textContent).toBe("signed_out:false");
});
it("cancels a scheduled refresh when the account view unmounts", async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.render();
  await act(async () => window.dispatchEvent(new Event("focus")));
  await act(async () => window.dispatchEvent(new Event("online")));
  await act(async () => root.render(null));
  await act(async () => vi.advanceTimersByTimeAsync(60000));
  expect(f.api.refreshProfile).toHaveBeenCalledTimes(1);
});

it("queues one recovery when connectivity returns during an in-flight refresh", async () => {
  vi.useFakeTimers();
  const f = fixture();
  let resolve!: (state: AccountState) => void;
  vi.mocked(f.api.refreshProfile).mockImplementationOnce(() => {
    f.publish({ busy: true });
    return new Promise((done) => {
      resolve = done;
    });
  });
  await f.render();
  await act(async () => window.dispatchEvent(new Event("focus")));
  await act(async () => window.dispatchEvent(new Event("online")));
  await act(async () => resolve(f.publish({ busy: false, stale: true })));
  await act(async () => vi.advanceTimersByTimeAsync(30000));
  expect(f.api.refreshProfile).toHaveBeenCalledTimes(2);
  await act(async () => vi.advanceTimersByTimeAsync(60000));
  expect(f.api.refreshProfile).toHaveBeenCalledTimes(2);
});

it("reports an offline profile and refreshes it when connectivity returns", async () => {
  const f = fixture({ ...cached, stale: false });
  vi.mocked(f.api.reportProfileOffline).mockImplementationOnce(async () =>
    f.publish({ details: { status: "unavailable" } })
  );
  await f.render();
  await act(async () => window.dispatchEvent(new Event("offline")));
  expect(f.api.reportProfileOffline).toHaveBeenCalledOnce();
  expect(f.api.refreshProfile).not.toHaveBeenCalled();
  await act(async () => window.dispatchEvent(new Event("online")));
  expect(f.api.refreshProfile).toHaveBeenCalledOnce();
});
