import { useRef, useState } from "react";
import {
  Button,
  Popover,
  SidebarMenuItem,
  SidebarMenuButton
} from "@koed-labs/ui";
import { X } from "lucide-react";
import type { AccountDesktopApi } from "@koed-labs/shared/account";
import { AccountBadgeAvatar, AccountPanel } from "./account-panel.js";
import { useAccountState } from "./use-account-state.js";

export function AccountMenu({
  api = window.koedDesktop?.account,
  onExpand
}: {
  api?: AccountDesktopApi;
  onExpand: () => void;
}) {
  const { state, accept } = useAccountState(api);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const openingSettings = useRef(false);
  if (!state || !api || state.status === "unavailable") return null;
  const profile = state.profile;
  const name = profile?.displayName?.trim() || profile?.email || "Account";
  function expand() {
    openingSettings.current = true;
    trigger.current?.focus();
    setOpen(false);
    onExpand();
  }
  return (
    <SidebarMenuItem>
      <Popover.Root
        open={open}
        onOpenChange={(next) => {
          if (next) openingSettings.current = false;
          setOpen(next);
        }}
      >
        <Popover.Trigger
          render={
            <SidebarMenuButton
              ref={trigger}
              className="v1-account-badge"
              aria-label={`Account menu: ${name}`}
              title="Account"
            >
              <AccountBadgeAvatar
                key={profile?.id + (profile?.profilePictureUrl ?? "")}
                profile={profile}
              />
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
              finalFocus={() =>
                openingSettings.current ? false : trigger.current
              }
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
              <AccountPanel
                api={api}
                state={state}
                accept={accept}
                onExpand={expand}
              />
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </SidebarMenuItem>
  );
}
