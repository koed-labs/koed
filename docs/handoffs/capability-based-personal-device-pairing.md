# Handoff: Capability-Based Personal Device Pairing

Status: Pairing hardening implementation and static/unit validation present;
DB-backed and Studio live validation pending.

Parent handoff: `docs/handoffs/unify-pds-secret-storage.md`.

## Goal

Simplify Personal Device Sync enrollment so that a one-time invitation link is the
user's authorization capability. Remove the human-facing short code and the
separate Authority approval action while preserving encrypted enrollment,
headless SSH support, and safe local secret custody.

The target model follows Paseo's linked-device flow: the Authority User creates
and deliberately transfers an invitation link; a valid redemption completes
enrollment without a second approval step.

## Decisions

- A valid one-time Personal Device invitation authorizes enrollment.
- The authorization policy is not restricted to local, Tailscale, or private
  endpoints. Network transport and authorization are separate concerns.
- The current build must continue to use Tailscale/private-network transport and
  must not expose the existing private HTTP pairing server publicly.
- Future remote pairing may use the same authorization policy only when its
  transport is HTTPS or a secure relay.
- Remove the human-facing pairing short code entirely. Do not replace it with a
  different code.
- Retain the opaque invitation token, internal `challenge_id`, signed device
  request, encrypted exchange, expiry, single-use enforcement, replay
  protection, and device revocation.
- Do not put invitation links in logs, analytics, shell history, or ordinary
  persistent files. CLI/SSH users must use stdin or an inherited file
  descriptor, never a link argument. Desktop paste or QR scan is preferred;
  OS `koed://pair/redeem` activation is supported but can expose the URL through
  platform launch plumbing: macOS normally uses Electron's `open-url` event,
  while Windows/Linux may provide it in argv. Koed must not log or persist that
  URL.
- Keep low-level Authority approval operations available for recovery or
  administrative diagnostics if needed, but remove them from the ordinary
  Personal Device pairing path.

## Target user flow

### Authority Desktop

1. Open **Devices**.
2. Click **Pair another device**.
3. Copy the one-time link or show it as a QR code.
4. The UI displays the invitation expiry and connection state.
5. When the other device completes enrollment, show **Connected**.

There is no short-code comparison and no **Approve device** button.

### Joining Desktop

1. Open **Devices → Join with link**.
2. Paste, scan, or open the one-time link.
3. Click **Connect device**.
4. Show **Connecting** and then **Connected**.

The UI keeps one link input only. It may accept a `koed://pair/redeem` deep link or QR
scan and populate the same input. The link is cleared after redemption and is
never persisted or logged.

### SSH-only joining device

```bash
koed-server personal-sync join redeem \
  --link-stdin \
  --device-label Studio
```

The joining device generates its own keys, submits a signed request, waits for
automatic completion, stores its encrypted runtime locally, reconciles its
local group, and exits successfully. `--link-fd` remains available for a
supervisor or secure wrapper with an inherited input stream.

## Current implementation state

Capability pairing implementation is present for this handoff:

- One-time invitation link possession authorizes Personal Device enrollment.
- Human-facing short-code comparison and ordinary Authority approval are
  removed from the intended flow.
- Authority validates expiry, group, transport binding, signed request, and
  single-use state before automatic enrollment.
- Desktop pairing uses one link input, QR/deep-link population, connection
  progress, cancellation while waiting/connecting, and completion refresh.
- SSH-only redemption keeps `--link-stdin` and `--link-fd`; `--link` is
  removed. Invitation links do not belong in CLI arguments, logs, shell history,
  or persistent files. Desktop OS protocol activation is the documented argv
  exception described above.
- The pairing listener binds one concrete private IPv4 interface, never a
  wildcard or public address. Invitation and relay URLs use that exact bound
  origin; Tailscale/private-network HTTP remains the transport boundary.
- Claimed request state is persisted through the encrypted application-managed
  PDS store. Listener startup restores only claimed, still-bounded records; the
  Desktop manager then resumes automatic enrollment. Waiting invitations are
  not made durable.
- Recovery persists the canonical signed request, device label, approval state,
  expiry, and used encrypted message IDs. Recovery is bounded to ten minutes;
  completed enrollment keeps a second ten-minute window for final completion
  replay, with at most 64 encrypted exchanges per invitation. Each final retry
  uses a fresh message ID, while a reused message ID is rejected.
- Pairing responses and requests remain size-bounded. Desktop protected payloads
  are written to a `0600` temporary file, fsynced, reopened read-only, unlinked
  before the child receives its descriptor, and closed after use. Startup only
  removes stale files from the pre-unlink implementation when their owner PID is
  gone.

Package-scoped validation is recorded below. Root DB-backed verification, Studio
Tailscale end-to-end completion, and live crash/restart validation remain
unclaimed.

## Implementation and validation record

### 1. Short-code plumbing removed

Pairing protocol and consumers no longer expose:

- `shortCode` fields in pairing views, progress events, or results.
- `--expected-code` parsing or validation.
- Short-code generation, comparison errors, or renderer copy.
- The ordinary `personal_sync_pairing_approve` UI command.

Related Desktop, server, CLI, and shared tests were updated. Keep `challenge_id`
as an internal invitation binding identifier; it is not a human-facing code and
must not be displayed as one.

### 2. Enrollment stages merged

On receipt of a pairing request, the Authority-side flow:

1. Validates the invitation, expiry, group, transport binding, and one-time
   claim state.
2. Validates the joining device's signed request and public-key material.
3. Performs Authority-side membership approval automatically.
4. Releases the encrypted enrollment response.
5. Completes local reconciliation and closes the invitation.

The operation is idempotent and race-safe. Invalid, expired, replayed,
wrong-group, or malformed requests never auto-approve. The normal pairing state
machine no longer exposes `approval_required`; it reports states such as
`waiting`, `connecting`, `completed`, `expired`, `cancelled`, and `failed`, with
`committing` and `awaiting_joiner` phases inside `connecting`. The commit
boundary rejects cancellation and keeps retryable enrollment alive. A claimed
request keeps its exact signed request binding if its HTTP response disconnects;
invitation expiry then rejects metadata and new requests. The exact bound request
may recover approval, and an already-approved bound session may use allowlisted
control and completion operations during the same bounded ten-minute
commit-recovery window. Recovery expiry clears token and request state, so no
expired capability remains indefinitely.

### 3. Desktop IPC and UI simplified

- Pairing wait/completion triggers Authority-side automatic enrollment.
- The **Approve device** button and code-comparison copy are removed.
- Connection progress and completion copy replace manual approval state.
- Cancellation remains available before commit; after commit, status polling
  reports the durable transition and cancellation returns an error.
- The device list refreshes after completion.

Low-level approval primitives remain available where recovery or administrative
operations still require them.

### 4. Headless setup stays self-configuring

- Application-managed secret storage and strict file permissions remain in use.
- `setup core` continues provisioning the scoped local credential.
- Documented redemption requires no Electron, OS keychain access, `keytar`, or
  plaintext secret configuration.
- Runtime secret references and provider wiring retain safe application defaults.

### 5. Documentation updated

Pairing sections in `docs/running-koed.md`, `docs/configuration.md`,
`docs/desktop-ui.md`, and this parent handoff document link possession as the
authorization capability and describe its one-time, short-lived, sensitive
nature.

### 6. Validation record

#### Static/unit validation passed

- Desktop full package suite: 77 files / 726 tests passed.
- `@koed/koed-server` full package suite: 42 files / 568 tests passed.
- `@koed/shared` full package suite: 51 files / 520 tests passed.
- API scoped-local-credential boundary test: 1 test passed.
- Desktop and server TypeScript checks passed.
- Prettier check passed for handoff, running, and configuration docs.

Coverage includes concrete private listener selection and invitation-origin
binding; exact loopback-origin parsing; scoped local Desktop credential plus
loopback enforcement; bounded request/response streams; encrypted-store
permission/atomic/restart tests; claimed disconnect binding; durable recovery
restore; startup resume hooks; persistence failure ordering; message reservation
before forwarding; completed-state replay; three-attempt final completion retry
with fresh message IDs; recovery expiry; and unlinked transient FD cleanup.

These are package/static/unit checks. Recovery tests use injected persistence and
an in-process server close/start sequence; they do not claim an OS process crash,
power-loss, or live Desktop crash-restart E2E.

#### Outstanding live and DB validation

- Root DB-backed verification was not run. Root `pnpm verify` requires usable
  `DATABASE_URL` and Postgres; API boundary coverage above uses a fake
  repository.
- Studio live Tailscale pairing remains blocked; no Studio end-to-end result is
  claimed.
- Successful Desktop and SSH enrollment against two live local APIs, including
  QR/deep-link platform delivery and real post-restart recovery, remain pending.
- Platform-specific `koed://pair/redeem` activation and token exposure checks remain
  pending; Windows/Linux argv delivery is an OS-handler caveat, not a blanket
  no-argv guarantee.

No live crash E2E is claimed.

## Transport expansion boundary

This stage changes Personal Device authorization, not public networking. The
current pairing link is an HTTP private-network endpoint and remains restricted
to private/Tailscale addresses in this build. Do not weaken that parser or bind
an unrestricted public listener as part of this work.

A later public/remote pairing effort must define and validate:

- HTTPS or secure relay transport.
- Advertised endpoint and certificate handling.
- Rate limiting and abuse/DoS controls.
- Invitation cancellation and audit visibility.
- Public-network threat modeling for bearer invitation links.

## Known unrelated follow-ups

- Six API terminal-runtime tests still report
  `ExecutionCheckoutIdentityChangedError`; PDS-specific tests are green.
- Historical ingestion can overload local API/listener capacity and needs a
  deliberate throttling or startup-policy decision.

These should not block the pairing UX implementation, but the final validation
report must continue to distinguish them from PDS failures.

## Release decision

Operator confirmed a minor changeset for this user-visible pairing and
security-policy change. `.changeset/capability-based-device-pairing.md` records
that release note. Validation remains pending.
