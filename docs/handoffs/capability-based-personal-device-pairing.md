# Handoff: Capability-Based Personal Device Pairing

Status: Capability pairing implementation and package validation present;
live validation pending on `docs/pds-secret-storage-handoff`.

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
- Do not put invitation links in logs, analytics, shell history, process
  arguments, or ordinary persistent files. SSH users should use stdin or an
  inherited file descriptor.
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

The UI keeps one link input only. It may accept a `koed-pair://` deep link or QR
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
- SSH-only redemption keeps `--link-stdin` and `--link-fd`; invitation links do
  not belong in arguments, logs, shell history, or persistent files.
- Tailscale/private-network HTTP transport, encrypted pairing, signed requests,
  replay protection, device revocation, and application-managed encrypted PDS
  storage remain unchanged.

Package-scoped validation is recorded below. Root DB-backed verification and
Studio Tailscale end-to-end completion remain unclaimed.

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

Passed package-scoped validation:

- Desktop pairing-server regression suite: 15 tests passed.
- Desktop full package suite: 76 files / 712 tests passed.
- `@koed/koed-server` full package suite: 41 files / 553 tests passed.
- Desktop TypeScript check passed.
- Prettier check passed for changed pairing server and regression-test files.

The claimed-binding regression test covers disconnect after claim, preservation of
the original signed request, rejection of changed requests and metadata after
invitation expiry, successful allowlisted control/completion recovery, exact
durable-commit recovery, and bounded recovery expiry.

Remaining validation is blocked or pending:

- Root DB-backed verification was not run. Root `pnpm verify` requires a usable
  `DATABASE_URL` and Postgres; package-scoped tests above were run instead.
- Studio live Tailscale pairing remains blocked; no Studio end-to-end result is
  claimed.

Remaining coverage and live validation:

- Successful automatic enrollment from Desktop.
- Successful automatic enrollment through SSH stdin and FD input.
- Joining Desktop link input and deep-link/QR population.
- Expired invitations.
- Replay and concurrent redemption.
- Wrong-group invitations.
- Invalid signatures and altered invitation fields.
- Device revocation after automatic enrollment.
- No short-code fields or code-related output.
- No invitation token leakage through process arguments or logs.

Package checks above pass. Root DB-backed verification and Studio Tailscale
end-to-end flow remain pending for the blockers recorded above.

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
