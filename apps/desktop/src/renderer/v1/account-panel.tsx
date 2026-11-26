import { useEffect, useId, useRef, useState } from "react";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  Checkbox
} from "@koed-labs/ui";
import { Expand, Globe, LogIn, LogOut, RefreshCw } from "lucide-react";
import type {
  AccountDesktopApi,
  AccountProfile,
  AccountState
} from "@koed-labs/shared/account";
import { Group } from "./settings-controls.js";
import {
  DesktopNotification,
  type DesktopNotice
} from "./DesktopNotification.js";
import "./account-menu.css";

export function AccountPanel({
  api,
  state,
  accept,
  onExpand
}: {
  api: AccountDesktopApi;
  state: AccountState;
  accept: (state: AccountState) => void;
  /** The rail popover links to the full panel in Settings. */
  onExpand?: () => void;
}) {
  const noticeId = useId();
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [notification, setNotification] = useState<{
    revision: number;
    notice: DesktopNotice | null;
  } | null>(null);
  const actionId = useRef(0);
  useEffect(() => {
    return () => {
      actionId.current++;
    };
  }, [api]);
  const run = async (
    action: () => Promise<AccountState>,
    feedback?: {
      confirmation: (next: AccountState) => string | null;
      failure: { message: string; error: string };
    }
  ) => {
    const id = ++actionId.current;
    setError(null);
    setNotification(null);
    setWorking(true);
    try {
      const next = await action();
      if (id !== actionId.current) return;
      accept(next);
      if (!feedback || next.busy) return;
      const sameProfile =
        next.status === "signed_in" && next.profile?.id === state.profile?.id;
      const expired =
        next.status === "reauthentication_required" &&
        next.messageCode === "session_expired";
      if (!sameProfile && !expired) return;
      if (
        next.stale ||
        next.message ||
        next.messageCode ||
        next.details?.status === "unavailable"
      ) {
        setNotification({
          revision: next.revision,
          notice: {
            ...feedback.failure,
            error: next.message ?? feedback.failure.error
          }
        });
      } else {
        const message = feedback.confirmation(next);
        if (message)
          setNotification({ revision: next.revision, notice: { message } });
      }
    } catch {
      if (id === actionId.current) {
        if (feedback)
          setNotification({
            revision: state.revision,
            notice: feedback.failure
          });
        else
          setError("The account action could not be completed. Please retry.");
      }
    } finally {
      if (id === actionId.current) setWorking(false);
    }
  };

  function saveEmailUpdates(subscribed: boolean) {
    return run(
      () => api.setEmailUpdates({ subscribed, stateRevision: state.revision }),
      {
        failure: {
          message: "Email preference could not be confirmed.",
          error: "Refresh your profile and try again."
        },
        confirmation: (next) =>
          next.revision > state.revision &&
          next.details?.status === "ready" &&
          next.details.value.userId === state.profile?.id &&
          next.details.value.emailUpdates.subscribed === subscribed
            ? subscribed
              ? "Email updates turned on."
              : "Email updates turned off."
            : null
      }
    );
  }

  const busy = working || state.busy;
  const profile = state.profile;
  const preference =
    state.status === "signed_in" &&
    !state.stale &&
    state.details?.status === "ready" &&
    state.details.value.userId === profile?.id
      ? state.details.value.emailUpdates
      : null;
  const signingIn = state.status === "signing_in";
  const restoring = state.status === "restoring";
  const expired = state.status === "reauthentication_required";
  const currentNotification =
    notification?.revision === state.revision ? notification : null;
  const message =
    currentNotification ||
    state.messageCode === "sign_out_complete" ||
    state.messageCode === "email_updates_unconfirmed"
      ? null
      : state.message;
  const notice = error || message;
  let content;
  if (state.status === "signed_in" && profile) {
    const name = profile.displayName?.trim() || profile.email;
    const identity = (
      <div className="v1-account-identity">
        <AccountBadgeAvatar
          key={profile.id + profile.profilePictureUrl}
          profile={profile}
        />
        <div>
          <strong>{name}</strong>
          {name.toLowerCase() !== profile.email.toLowerCase() && (
            <small>{profile.email}</small>
          )}
        </div>
      </div>
    );
    const signOut = (
      <Button
        className={onExpand ? "v1-account-row" : undefined}
        variant="ghost"
        size="sm"
        disabled={busy}
        onClick={() => void run(() => api.signOut())}
      >
        <LogOut />
        Sign out
      </Button>
    );
    if (onExpand) {
      content = (
        <>
          {identity}
          <div className="v1-account-rows">
            <Button
              className="v1-account-row"
              variant="ghost"
              onClick={onExpand}
            >
              <Expand />
              Expand
            </Button>
            {signOut}
          </div>
        </>
      );
    } else {
      const joined = profile.joinedAt;
      content = (
        <section className="v1-account-settings">
          <div className="v1-account-profile-card">
            {identity}
            <dl>
              <div>
                <dt>Account tier</dt>
                <dd>Free</dd>
              </div>
              <div>
                <dt>Joined</dt>
                <dd>
                  {joined ? (
                    <time dateTime={joined}>
                      {new Intl.DateTimeFormat(undefined, {
                        dateStyle: "long",
                        timeZone: "UTC"
                      }).format(new Date(joined))}
                    </time>
                  ) : (
                    "Unavailable"
                  )}
                </dd>
              </div>
            </dl>
          </div>
          <Group title="Preferences">
            {preference ? (
              <label className="setting-row v1-account-consent">
                <Checkbox
                  aria-label="Email updates"
                  aria-describedby={noticeId}
                  checked={preference.subscribed}
                  disabled={busy}
                  onCheckedChange={(subscribed) =>
                    void saveEmailUpdates(subscribed)
                  }
                />
                <span>
                  <strong>Email updates</strong>
                  <span id={noticeId}>
                    {preference.noticeText}
                    {preference.email !== profile.email && (
                      <small>{preference.email}</small>
                    )}
                  </span>
                </span>
              </label>
            ) : (
              <p className="setting-row v1-account-consent" role="status">
                {state.details?.status === "loading"
                  ? "Loading email preferences…"
                  : "Email preferences are unavailable."}
              </p>
            )}
          </Group>
          <div className="v1-account-actions">
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(() => api.refreshProfile(), {
                  confirmation: (next) =>
                    !next.details || next.details.status === "ready"
                      ? "Profile refreshed."
                      : null,
                  failure: {
                    message: "Could not refresh your profile.",
                    error: "Please try again."
                  }
                })
              }
            >
              <RefreshCw />
              Refresh profile
            </Button>
            {signOut}
          </div>
        </section>
      );
    }
  } else {
    content = (
      <section className="v1-account-status">
        {signingIn ? <Globe /> : <HappyAccountKin />}
        <h3>
          {signingIn
            ? "Continue in your browser"
            : restoring
              ? "Restoring your account…"
              : expired
                ? "Sign in again"
                : "Sign in to Koed"}
        </h3>
        {!restoring && (
          <p>
            {signingIn
              ? "Finish signing in to return to your account."
              : expired
                ? "Your session has expired. Sign in again to manage your account."
                : "Sign in to stay up to date with koed and gain early access to new features 🚀"}
          </p>
        )}
        {signingIn ? (
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
              onClick={() => void run(() => api.signIn({ screen: "sign-in" }))}
            >
              <LogIn />
              {expired ? "Sign in again" : "Sign in"}
            </Button>
          )
        )}
      </section>
    );
  }
  return (
    <>
      {content}
      {currentNotification?.notice && (
        <DesktopNotification
          notice={currentNotification.notice}
          onDismiss={() =>
            setNotification({
              revision: currentNotification.revision,
              notice: null
            })
          }
        />
      )}
      {notice && (
        <p className="v1-account-note" role={error ? "alert" : "status"}>
          {notice}
        </p>
      )}
    </>
  );
}
export function AccountBadgeAvatar({
  profile
}: {
  profile: AccountProfile | null;
}) {
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
