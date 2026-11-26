import { useEffect, useId, useRef, useState } from "react";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  Popover,
  Switch,
  SidebarMenuItem,
  SidebarMenuButton
} from "@koed-labs/ui";
import {
  ArrowLeft,
  ChevronRight,
  Globe,
  LogIn,
  LogOut,
  Mail,
  RefreshCw,
  WifiOff,
  X
} from "lucide-react";
import type {
  AccountDesktopApi,
  AccountProfile,
  AccountState
} from "@koed-labs/shared/account";
import "./account-menu.css";
import { useAccountState } from "./use-account-state.js";

export function AccountMenu({
  api = window.koedDesktop?.account
}: {
  api?: AccountDesktopApi;
}) {
  const { state, accept } = useAccountState(api);
  const [emailOwner, setEmailOwner] = useState<string | null>(null);
  const emailRow = useRef<HTMLButtonElement>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  const noticeId = useId();
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    revision: number;
    text: string;
  } | null>(null);
  useEffect(() => {
    if (!confirmation) return;
    const timeout = setTimeout(() => setConfirmation(null), 2400);
    return () => clearTimeout(timeout);
  }, [confirmation]);
  const actionId = useRef(0);
  useEffect(() => {
    return () => {
      actionId.current++;
    };
  }, [api]);
  const run = async (
    action: () => Promise<AccountState>,
    confirmed?: (next: AccountState) => string | null
  ) => {
    const id = ++actionId.current;
    setError(null);
    setConfirmation(null);
    setWorking(true);
    try {
      const next = await action();
      if (id !== actionId.current) return;
      accept(next);
      if (
        next.status === "signed_in" &&
        !next.stale &&
        next.profile?.id === state?.profile?.id &&
        next.details?.status === "ready" &&
        !next.messageCode
      ) {
        const text = confirmed?.(next);
        if (text) setConfirmation({ revision: next.revision, text });
      }
    } catch {
      if (id === actionId.current)
        setError("The account action could not be completed. Please retry.");
    } finally {
      if (id === actionId.current) setWorking(false);
    }
  };
  const profile = state?.profile ?? null;
  const signedIn = state?.status === "signed_in" && !!profile;
  const offline =
    signedIn && (state.stale || state.details?.status === "unavailable");
  const emailUpdates =
    signedIn &&
    !offline &&
    state.details?.status === "ready" &&
    state.details.value.userId === profile.id
      ? state.details.value.emailUpdates
      : null;
  const emailPage = !!emailUpdates && emailOwner === profile?.id;
  useEffect(() => {
    if (emailPage) backButton.current?.focus();
    else setEmailOwner(null);
  }, [emailPage]);
  if (!api || !state || state.status === "unavailable") return null;
  const signingIn = state.status === "signing_in";
  const restoring = state.status === "restoring";
  const expired = state.status === "reauthentication_required";
  const message =
    state.messageCode === "sign_out_complete"
      ? null
      : (state.message ??
        (confirmation?.revision === state.revision ? confirmation.text : null));
  const name = profile?.displayName?.trim() || profile?.email || "Account";
  const showEmail =
    profile && name.toLowerCase() !== profile.email.toLowerCase();
  const busy = state.busy || working;
  const avatar = (
    <AccountBadgeAvatar
      key={profile?.id + (profile?.profilePictureUrl ?? "")}
      profile={profile}
    />
  );
  const refreshProfile = () =>
    void run(
      () => api.refreshProfile(),
      () => "Profile refreshed."
    );
  const signOut = (
    <Button
      className="v1-account-row"
      variant="ghost"
      disabled={working}
      onClick={() => void run(() => api.signOut())}
    >
      <LogOut />
      Sign out
    </Button>
  );
  return (
    <SidebarMenuItem>
      <Popover.Root
        onOpenChange={() => {
          setEmailOwner(null);
          setConfirmation(null);
        }}
      >
        <Popover.Trigger
          render={
            <SidebarMenuButton
              className="v1-account-badge"
              aria-label={`Account menu: ${name}`}
              title="Account"
            >
              {avatar}
            </SidebarMenuButton>
          }
        />
        <Popover.Portal>
          <Popover.Positioner
            side="right"
            align="end"
            sideOffset={() =>
              window.matchMedia("(max-width: 560px)").matches ? 4 : 18
            }
            alignOffset={() =>
              window.matchMedia("(max-width: 560px)").matches ? -3 : 2
            }
            collisionPadding={8}
            className="v1-account-positioner"
          >
            <Popover.Popup
              aria-label="Account"
              className="v1-app v1-account-popup"
            >
              <Popover.Close
                aria-label="Close account"
                className="v1-account-close"
                render={<Button variant="ghost" size="icon-sm" />}
              >
                <X />
              </Popover.Close>
              {emailPage ? (
                <>
                  <Button
                    className="v1-account-back"
                    variant="ghost"
                    size="sm"
                    ref={backButton}
                    onClick={() => {
                      setEmailOwner(null);
                      requestAnimationFrame(() => emailRow.current?.focus());
                    }}
                  >
                    <ArrowLeft />
                    Account
                  </Button>
                  <section className="v1-account-preference">
                    <div>
                      <h3>
                        <Mail />
                        Email updates
                      </h3>
                      <Switch
                        aria-label="Email updates"
                        aria-describedby={noticeId}
                        checked={emailUpdates.subscribed}
                        disabled={busy}
                        onCheckedChange={(subscribed) =>
                          void run(
                            () =>
                              api.setEmailUpdates({
                                subscribed,
                                stateRevision: state.revision
                              }),
                            (next) =>
                              next.details?.status === "ready" &&
                              next.details.value.emailUpdates.subscribed ===
                                subscribed
                                ? subscribed
                                  ? "Email updates turned on."
                                  : "Email updates turned off."
                                : null
                          )
                        }
                      />
                    </div>
                    <p id={noticeId}>
                      {emailUpdates.noticeText}
                      <small>{emailUpdates.email}</small>
                    </p>
                  </section>
                </>
              ) : (
                <>
                  {signedIn && (
                    <div className="v1-account-identity">
                      {avatar}
                      <div>
                        <strong>{name}</strong>
                        {showEmail && <small>{profile.email}</small>}
                      </div>
                    </div>
                  )}
                  {signedIn && !offline ? (
                    <>
                      {emailUpdates && (
                        <div className="v1-account-rows">
                          <Button
                            variant="ghost"
                            className="v1-account-row"
                            ref={emailRow}
                            onClick={() => setEmailOwner(profile.id)}
                          >
                            <Mail />
                            Email updates
                            <small>
                              {emailUpdates.subscribed ? "On" : "Off"}
                            </small>
                            <ChevronRight />
                          </Button>
                        </div>
                      )}
                      {state.details?.status === "loading" && (
                        <p role="status" className="v1-account-note">
                          Loading account profile…
                        </p>
                      )}
                      <div className="v1-account-rows">
                        {state.details?.status === "ready" && (
                          <Button
                            className="v1-account-row"
                            variant="ghost"
                            disabled={busy}
                            onClick={refreshProfile}
                          >
                            <RefreshCw />
                            Refresh profile
                          </Button>
                        )}
                        {signOut}
                      </div>
                    </>
                  ) : (
                    <section className="v1-account-status">
                      {offline ? (
                        <WifiOff />
                      ) : signingIn ? (
                        <Globe />
                      ) : (
                        <HappyAccountKin />
                      )}
                      <h3>
                        {offline
                          ? "Account offline"
                          : signingIn
                            ? "Continue in your browser"
                            : restoring
                              ? "Restoring your account…"
                              : expired
                                ? "Sign in again"
                                : "Sign in to Koed"}
                      </h3>
                      {!restoring && (
                        <p>
                          {offline
                            ? "Reconnect to check or change your email updates."
                            : signingIn
                              ? "Finish signing in to return to your account."
                              : expired
                                ? "Your session has expired. Sign in again to manage your account."
                                : "Sign in to stay up to date with koed and gain early access to new features 🚀"}
                        </p>
                      )}
                      {offline ? (
                        <>
                          <Button disabled={busy} onClick={refreshProfile}>
                            <RefreshCw />
                            Retry profile
                          </Button>
                          {signOut}
                        </>
                      ) : signingIn ? (
                        <Button
                          variant="outline"
                          onClick={() => void run(() => api.cancelSignIn())}
                        >
                          Cancel sign-in
                        </Button>
                      ) : (
                        !restoring && (
                          <Button
                            disabled={busy}
                            onClick={() =>
                              void run(() => api.signIn({ screen: "sign-in" }))
                            }
                          >
                            <LogIn />
                            {expired ? "Sign in again" : "Sign in"}
                          </Button>
                        )
                      )}
                    </section>
                  )}
                </>
              )}
              {(error || message) && (
                <p
                  className="v1-account-note"
                  role={error ? "alert" : "status"}
                >
                  {error || message}
                </p>
              )}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </SidebarMenuItem>
  );
}

function AccountBadgeAvatar({ profile }: { profile: AccountProfile | null }) {
  const [image, setImage] = useState<"loading" | "loaded" | "failed">(
    "loading"
  );
  const initials = (profile?.displayName || profile?.email || "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
  return (
    <Avatar className="v1-account-avatar" aria-hidden="true">
      {image !== "loaded" && (
        <AvatarFallback>{initials || <HappyAccountKin />}</AvatarFallback>
      )}
      {profile?.profilePictureUrl && image !== "failed" && (
        <AvatarImage
          src={profile.profilePictureUrl}
          alt=""
          referrerPolicy="no-referrer"
          decoding="async"
          onLoad={() => setImage("loaded")}
          onError={() => setImage("failed")}
        />
      )}
    </Avatar>
  );
}

function HappyAccountKin() {
  return <span className="v1-account-kin" aria-hidden="true" />;
}
