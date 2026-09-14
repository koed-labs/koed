# Handoff: Capability-Based Personal Device Pairing

Status: Next implementation stage planned on `docs/pds-secret-storage-handoff`.

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

Already implemented in the current working tree or branch:

- Tailscale private-network support, including `100.64.0.0/10`.
- SSH-only redemption through `--link-stdin` and `--link-fd`.
- Encrypted pairing transport and signed enrollment requests.
- Unified application-managed encrypted PDS secret storage.
- Headless `setup core` provisioning of the scoped local reconciliation
  credential.
- Local reconciliation and device revocation support.
- Documentation and regression coverage for headless credential provisioning.

The following work is planned and is not yet implemented:

- Short-code removal.
- Automatic Personal Device enrollment without a separate Authority approval.
- UI state and copy changes for the new flow.

## Implementation plan

### 1. Remove short-code plumbing

Update the pairing protocol and all consumers to remove:

- `shortCode` fields from pairing views, progress events, and results.
- `--expected-code` parsing and validation.
- Short-code generation and comparison errors.
- Renderer state, display, accessibility labels, and copy.
- Related Desktop, server, CLI, and shared tests.

Keep `challenge_id` as an internal invitation binding identifier. It is not a
human-facing code and must not be displayed as one.

### 2. Merge the enrollment stages

On receipt of a pairing request, the Authority-side flow must:

1. Validate the invitation, expiry, group, transport binding, and one-time
   claim state.
2. Validate the joining device's signed request and public-key material.
3. Perform the Authority-side membership approval automatically.
4. Release the encrypted enrollment response.
5. Complete local reconciliation and close the invitation.

The operation must be idempotent and race-safe. An invalid, expired, replayed,
wrong-group, or malformed request must never be auto-approved.

The normal pairing state machine should no longer expose `approval_required`.
It should report states such as `waiting`, `connecting`, `completed`,
`expired`, `cancelled`, and `failed`.

### 3. Simplify Desktop IPC and UI

- Remove the normal `personal_sync_pairing_approve` UI path.
- Make the pairing wait/completion path trigger the Authority-side automatic
  enrollment operation.
- Remove the **Approve device** button.
- Replace code-comparison copy with connection progress and completion copy.
- Keep cancellation while the invitation is waiting or connecting.
- Refresh the device list after completion.

Do not delete any low-level approval primitive still needed for recovery or
administrative operations without checking its other callers first.

### 4. Keep headless setup self-configuring

- Preserve application-managed secret storage and strict file permissions.
- Keep `setup core` provisioning the scoped local credential.
- Ensure documented redemption does not require Electron, OS keychain access,
  `keytar`, or plaintext secret configuration.
- Confirm runtime secret references and provider wiring have safe application
  defaults where the pairing path already supports them.

### 5. Update documentation

Update the pairing sections in:

- `docs/running-koed.md`
- `docs/configuration.md`
- `docs/desktop-ui.md`
- This handoff's parent document, if its acceptance state changes

Document that link possession authorizes Personal Device enrollment, while the
link remains one-time, short-lived, and sensitive.

### 6. Add validation coverage

Add or update tests for:

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

Then run the relevant package tests, typechecks, builds, and formatting checks,
followed by the Studio Tailscale end-to-end flow.

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

This is a user-visible pairing and security-policy change. Recommend a minor
changeset. Do not add the changeset until the Operator confirms the release
note decision.
