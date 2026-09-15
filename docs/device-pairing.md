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
It then feeds completed-turn capture records and verifies automatic encrypted
checkpoint publication, successive turns in one received Session, verified origin
badges, and semantic recall in both directions. It does not call the permanent
close/publish endpoint. This is an ingestion-to-replication smoke; physical
AI Client watcher validation remains a separate end-to-end check.
Use `KOED_SMOKE_ASSET_HOME` for another prepared asset directory. Temporary homes
are removed after the test unless `KOED_KEEP_SMOKE_HOME=1` is selected explicitly.

Local publication on joined installations uses the enrolled device's secure key
context, not an Authority private key. Closing a session, retrying the local
outbox, pausing local publication, and reading local sync status retain owner
session or scoped Desktop authentication. Group governance still requires the
Authority.

## Device names and SSH status

The accepting Electron installation remembers the name shown during review, such
as `studio`. Use the pencil button in Devices to edit it. Names are local nicknames
for that installation, also used by the device selector; edits do not rename the
remote computer or change its cryptographic identity. Nicknames are stored under
`KOED_HOME/config/personal-device-names.json` and survive restarts.

On a running local Personal installation, `koed-server personal-sync status --json`
uses its scoped local credential automatically, including over SSH. No browser
session descriptor is required. An explicit control URL must match the running
installation's loopback API; local credentials are never forwarded elsewhere.

Normal CLI help focuses on `pair`, `pair status`, `pair cancel`, and Personal Sync
status. `koed-server personal-sync --help --advanced` lists retained low-level
protocol and recovery operations, which require their own authentication and
signed inputs. Previously advertised commands without implementations are no
longer listed. The setup wizard's AI Client selection step keeps its integration
checkboxes and Continue action without the redundant Continue explanation.

Received sessions show a computer-icon-and-name badge in the session list and
transcript header. The name uses this installation's nickname; unknown names fall
back to a short device identifier. The badge comes from a verified, ready Personal
Device replica observation, not transcript-supplied metadata. Local source sessions
and quarantined replicas do not receive a remote-device badge. Devices uses a
neutral computer icon because the pairing protocol does not carry hardware type.

### Automatic session checkpoints

After pairing with Personal Sync enabled, completed turns in new Captured
Sessions are published automatically. Both installations must run a version
supporting checkpoint manifests. Pi, Codex, and Claude Code use durable completion
evidence from capture; an idle terminal is not a permanent Session closure.

Open **Personal Projects** to inspect received Sessions. Sessions without a
matching Project may appear under **Unassigned**. The computer icon and local
device nickname identify a received Session. Open it to inspect the transcript;
a later completed turn extends that same Session. Received Sessions are read-only,
and their source AI Client identity is preserved. The originating Conversation
remains resumable on its original device.

**Paired** describes group membership, not successful transfer. Devices also
reports local publication, transfer, processing, or attention state. A local queue
being up to date does not assert that an offline peer has captured no new activity.
Keep the Authority-hosting Electron app running and both devices reachable over
LAN/Tailscale for the current transport. Checkpoints waiting for predecessors
resume as those predecessors arrive; duplicate delivery is harmless. When a new
device joins, retained eligible checkpoints are queued for its current membership
so it can catch up before receiving later turns.

Automatic publication covers Sessions created after Personal Sync Policy was
enabled. Pairing does not import historical sessions. The checkpoint manifest is
versioned separately from the existing permanent closed-session manifest, whose
immutability remains enforced. See [ADR-0045](adr/0045-incremental-personal-session-checkpoints.md)
for ordering, compatibility, and the initial cumulative-package size trade-off.
