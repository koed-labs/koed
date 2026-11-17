import { useEffect, useRef, useState } from "react";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuPopup,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuItem,
  SidebarMenuItem,
  SidebarMenuButton
} from "@koed-labs/ui";
import { LogIn, LogOut, UserRound, X } from "lucide-react";
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
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const actionId = useRef(0);
  useEffect(() => {
    return () => {
      actionId.current++;
    };
  }, [api]);
  const run = async (action: () => Promise<AccountState>) => {
    const id = ++actionId.current;
    setError(null);
    setWorking(true);
    try {
      const next = await action();
      if (id !== actionId.current) return;
      accept(next);
    } catch {
      if (id === actionId.current)
        setError("The account action could not be completed. Please retry.");
    } finally {
      if (id === actionId.current) setWorking(false);
    }
  };
  if (!api || !state || state.status === "unavailable") return null;
  const profile = state.profile;
  const signingIn = state.status === "signing_in";
  const message =
    state.status === "signed_out" &&
    state.message ===
      "Signed out on this device. Complete browser sign-out if prompted."
      ? null
      : state.message;
  const name = profile?.displayName || profile?.email || "Account";
  const detail = error
    ? "Account action needs attention"
    : signingIn
      ? "Continue in your browser"
      : state.status === "restoring"
        ? "Restoring account…"
        : state.status === "reauthentication_required"
          ? "Sign in again"
          : profile
            ? state.stale
              ? "Offline · Cached profile"
              : profile.email
            : "Sign in";
  return (
    <SidebarMenuItem>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <SidebarMenuButton
              className="v1-account-badge"
              aria-label={`Account menu: ${name}`}
              title={`${name} · ${detail}`}
            >
              <AccountBadgeAvatar
                key={`${profile?.id}:${profile?.profilePictureUrl ?? ""}`}
                profile={profile}
              />
            </SidebarMenuButton>
          }
        />
        <DropdownMenuPopup
          className="v1-app v1-account-popup"
          side="right"
          align="start"
          sideOffset={8}
        >
          <DropdownMenuGroup>
            <DropdownMenuLabel className="v1-account-menu-heading">
              {state.status === "restoring" ? (
                <p className="v1-account-invitation" role="status">
                  Restoring your account…
                </p>
              ) : signingIn ? (
                <p className="v1-account-invitation">
                  Finish sign-in in your browser, or cancel to try again.
                </p>
              ) : profile ? (
                <>
                  <strong>{name}</strong>
                  <span>{profile.email}</span>
                </>
              ) : (
                <p className="v1-account-invitation">
                  Sign in to stay up to date with koed and gain early access to
                  new features 🚀
                </p>
              )}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {signingIn ? (
              <DropdownMenuItem
                onClick={() => void run(() => api!.cancelSignIn())}
              >
                <X aria-hidden="true" /> Cancel sign-in
              </DropdownMenuItem>
            ) : profile ? (
              <DropdownMenuItem
                onClick={() => void run(() => api!.signOut())}
                disabled={working}
              >
                <LogOut aria-hidden="true" /> Sign out
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem
                onClick={() =>
                  void run(() => api!.signIn({ screen: "sign-in" }))
                }
                disabled={state.busy || working || state.status === "restoring"}
              >
                <LogIn aria-hidden="true" />
                {state.status === "reauthentication_required"
                  ? "Sign in again"
                  : "Sign in"}
              </DropdownMenuItem>
            )}
          </DropdownMenuGroup>
          {(error || message) && (
            <p
              className="v1-account-menu-note"
              role={error ? "alert" : "status"}
            >
              {error || message}
            </p>
          )}
        </DropdownMenuPopup>
      </DropdownMenu>
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
        <AvatarFallback>{initials || <UserRound size={17} />}</AvatarFallback>
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
