---
"@koed/koed": minor
---

Let a joining headless or Electron installation create a device request link,
then review and accept it in the existing Authority-hosting Electron app.
Add `koed-server pair`, shared supervisor-owned request state, and native
Personal startup defaults without required environment flags. Remove the
mandatory recovery-file and recovery-code steps from device-group setup.
LAN or Tailscale connectivity is required; an internet pairing relay is not
included. Existing invitation redemption remains available for compatibility.

Allow the empty device overview before Authority configuration and identify the
local member as This device, with an explicit message when no other devices have
joined.

Remember reviewed device names and allow installation-local nicknames in Devices
and device selectors. Simplify the AI Client setup copy and CLI help, and let
Personal Sync status authenticate automatically on local SSH installations.

Show a computer icon and local device nickname on received sessions, and use
consistent computer icons in Devices instead of alternating laptop/phone icons.

Automatically publish completed-turn checkpoints from supported AI Client
capture, keeping source conversations resumable and received sessions read-only.
Preserve source client identity and append later checkpoints to the same local
session. Show pairing separately from local sync progress. Both devices need
this checkpoint-capable version; existing closed-session packages remain valid.
