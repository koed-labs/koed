# Connect Personal devices

Use a private LAN or Tailscale network. An internet-accessible pairing relay and
restricted-network traversal are not included. The installation that created the
Personal Device Group remains its Authority/Relay host and must be reachable.

## Joining through SSH

On the joining device, run:

```sh
koed-server pair
```

From a built source checkout, use `pnpm koed-server pair` instead. Koed starts or
reuses its native local Personal runtime, prints a ten-minute request link, and
waits. No environment exports, invitation input, or JSON file are required.
Missing native binaries/models are reported through normal runtime setup guidance;
Koed never silently substitutes Docker. Install the native runtime and embedding
model through the Quickstart when preparing a new machine.

Paste the link into **Devices → Add device** on the existing Electron installation.
Choose **Review device**, check the displayed device name and replication scope,
then choose **Add device**. Studio reports `connected` only after its local group
state has been reconciled into its own database.

`koed-server pair status` reports redacted progress. `koed-server pair cancel`
invalidates a waiting request. Once enrollment begins, wait for its outcome;
removal of an enrolled device is a separate membership operation. Ctrl-C detaches
the CLI display; the supervisor keeps the request until expiry. Run `pair` again
to reattach. `--detach` prints the request without waiting, and `--json` explicitly
requests structured output, including the secret link in the initial response.
Never put that response in ordinary logs or share it beyond the existing device.

## Joining from Electron

On the new installation, open **Devices → Connect to an existing device** and
copy the request link. Paste it into **Devices → Add device** on the existing
Authority-hosting Electron installation. Review and accept it there. Both CLI and
Electron use the same supervisor-owned request state and enrollment client.

A fresh installation can instead choose **Set up device sync** to create the
first group. This no longer downloads a recovery kit, displays a recovery code,
or requires an acknowledgment about storing a secret. The new group initially
contains only **This device**; setup does not connect another installation.
Choose **Add device** to connect Studio or another Electron installation. Without a separately
exported recovery kit, losing every enrolled installation loses group control;
create a new group in that case. Existing optional CLI recovery-kit operations
remain available for Operators who deliberately use them.

Existing enrolled replicas continue to capture and recall Personal Memory locally.
They do not receive the Authority private key or gain the ability to add devices.
Use the original Authority-hosting installation to approve a new request.

## Operation and failure behavior

The joining supervisor creates a narrow private-interface HTTP listener using an
available port. Its address and port are in the request link. The existing device
must reach that endpoint; the joining device must also reach the existing private
Authority/Relay endpoint for enrollment and subsequent synchronization. Reversing
the link does not remove those network requirements.

Requests use a separate `koed/pds-device-request/v1` authenticated encrypted
transport. The URL fragment carries a random 256-bit secret and is never included
in HTTP requests. Inspection is read-only. Explicit acceptance sends the existing
short-lived invitation through the encrypted exchange; the joining supervisor
then executes the existing signed enrollment, Key Bundle, and local reconciliation
protocol. The internal invitation is never displayed in the new flow.

Direction and message IDs are authenticated, replayed messages are rejected, and
acceptance is serialized and persisted before enrollment starts. Repeating the
same acceptance can acknowledge a lost response; a different invitation cannot
replace an accepted one. Request traffic is bounded by expiry, payload size,
connection count, and exchange count. The public listener exposes no local API,
credentials, operational controls, or Memory.

Pending links and accepted invitation state live in the application-managed
encrypted store under `KOED_HOME/secrets` (encrypted at rest). Local CLI/Electron
controls use an owner-only Unix socket. For long Koed home paths on macOS, a
validated owner-only directory under `/tmp` holds a short hashed socket name.
Waiting requests survive a supervisor restart with the same endpoint and expiry.
A restart during enrollment retries the retained invitation through the existing
reconciliation path; it never infers success solely from the presence of keys.
Failed enrollment is reported as failed, not connected, and requires checking
membership before starting another request.

The original `personal-sync join redeem --link-stdin`/`--link-fd` path is retained
for compatible older invitations. Request links and invitation links have distinct
paths and protocols and are not interchangeable. The primary Electron flow uses
joining-device request links.

## Validation

`pnpm pds-request:smoke` starts two disposable native local installations using
existing immutable runtime/model assets from `~/.koed`. It disables Transcript
Watchers, creates a group without exporting recovery material, exercises request
review and explicit acceptance through the Desktop manager, and verifies two
active members, joining database reconciliation, and no copied Authority key.
It then verifies encrypted session replication and semantic recall in both
directions.
Use `KOED_SMOKE_ASSET_HOME` for another prepared asset directory. Temporary homes
are removed after the test unless `KOED_KEEP_SMOKE_HOME=1` is selected explicitly.

Local publication on joined installations uses the enrolled device's secure key
context, not an Authority private key. Closing a session, retrying the local
outbox, pausing local publication, and reading local sync status retain owner
session or scoped Desktop authentication. Group governance still requires the
Authority.
