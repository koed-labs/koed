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
