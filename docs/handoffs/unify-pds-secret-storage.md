# Handoff: Unify PDS Secret Storage Across Electron and Headless CLI

Status: Storage and capability-pairing implementations complete; static/unit
validation passed; root DB-backed and Studio live validation pending. No live
process-crash or crash-restart E2E is claimed.

## Task

Refactor Koed Personal Device Sync (PDS) secret storage to use one consistent Koed-owned application-managed local secret-store model across Electron/Desktop and standalone/headless `koed-server` CLI.

Remove the current split where Electron uses its Desktop/platform `safeStorage` bridge and headless CLI uses `keytar`/native OS credential storage. The PDS store must not require Keychain, Credential Manager, Secret Service/KWallet, D-Bus, Electron, or an interactive session on either path. Preserve Tailscale pairing and SSH-only `personal-sync join redeem`.

This document records continuation scope and acceptance evidence. Do not mark
complete until platform and end-to-end checks pass.

## Context

The current headless CLI cannot reliably persist PDS runtime material on an SSH-only macOS device. `keytar` delegates to the macOS Keychain, but studio SSH processes fail with:

```text
User interaction is not allowed
```

This remained true after running:

```bash
security unlock-keychain "$HOME/Library/Keychains/login.keychain-db"
```

The desired experience is closer to WhatsApp linked devices and T3Code: a short-lived pairing invitation bootstraps a device, then the device persists its own long-lived PDS runtime material in application-managed local state. The intended local trust model is filesystem/account based, similar to an unencrypted SSH private key, with strict permissions and atomic writes.

The user explicitly chose to remove secure-storage integration differences across Electron and headless setups. Both paths should use the same application-managed local trust model. A T3Code/SSH-private-key-style filesystem store is acceptable: protect its directory and files with owner-only permissions and atomic writes, and document that same-user/root access remains in the threat model.

## Relevant files

- `packages/koed-server/src/application-secret-provider.ts` — bundled application-managed provider wiring for headless operation.
- `packages/koed-server/src/personal-sync.ts` — provider dispatch, PDS runtime secret get/put/delete, pending material, and SSH pairing redemption.
- `packages/koed-server/src/start.ts` — currently injects bundled native/headless provider into local service environments.
- `packages/koed-server/src/cli.ts` — currently exposes `secret-provider get|put|delete` and pairing CLI commands.
- `packages/koed-server/src/native-secret-provider.test.ts` — tests for the keytar provider; replace with application-managed store tests.
- `packages/koed-server/src/personal-sync.test.ts` — PDS provider and SSH pairing tests.
- `packages/shared/src/pds-secret-store.ts` and
  `packages/shared/src/encrypted-state-transaction-core.ts` — shared encrypted
  store and durable atomic transaction implementation.
- `packages/shared/src/encrypted-state-custody-internal.test.ts` and
  `packages/koed-server/src/application-secret-provider.test.ts` — encrypted
  custody, provider, permission, and restart coverage.
- `apps/desktop/src/pds-secure-provider.ts` — common application-managed Desktop
  store adapter and optional explicit Operator-managed provider.
- `apps/desktop/src/koed-server/manager.ts` — Desktop server/provider setup,
  pairing recovery resume, and protected FD handoffs.
- `apps/desktop/src/ipc/protected-json-fd.ts` — unlinked transient descriptor
  handoff and stale legacy-file cleanup.
- `packages/koed-server/package.json` and workspace lockfiles — confirm no
  `keytar` dependency remains on the PDS path.
- `docs/configuration.md` — PDS provider configuration.
- `docs/running-koed.md` — SSH pairing and operational guidance.
- `docs/service-sequence-overview.md` — provider/service-flow documentation.
- `CONTEXT.md`, `AGENTS.md`, `TODO.md` — canonical terminology, security/project constraints, and backlog.

## Current implementation state

Already implemented and tested on this branch:

- Tailscale private-network support (`100.64.0.0/10`).
- SSH-only `personal-sync join redeem`.
- Pairing link input via `--link-stdin` and `--link-fd`; the CLI `--link`
  argument is removed. Desktop paste/scan remains preferred, with documented
  OS protocol activation caveats.
- Encrypted application-level pairing transport.
- Automatic local API URL resolution for SSH redemption.
- An application-managed encrypted provider for standalone/headless operation;
  no `keytar` provider remains on the PDS path.
- CLI `secret-provider get|put|delete` commands, backed by the same store.

Historical validation before this storage continuation:

- Koed server tests: 552 passed.
- Server typecheck, build, and Prettier checks passed.
- Studio runtime services were healthy; overall status had an unrelated API-token HTTP 429 diagnostic.
- Studio `keytar`/`security` writes failed from SSH with `User interaction is not allowed`.

Current validation is recorded below. It supersedes this historical baseline and
uses the application-managed store; it does not claim live Studio enrollment.

T3Code was inspected at `/Users/jedd/.cache/checkouts/github.com/pingdotgg/t3code`. Its `apps/server/src/auth/ServerSecretStore.ts` creates a `0700` secrets directory, stores `0600` files, writes atomically, and reads directly from headless processes. It does not depend on `keytar` for server secret storage.

Continuation implementation now uses Koed's shared encrypted-state transaction
core for an application-managed PDS store at `KOED_HOME/secrets`. Electron,
headless CLI, API, and Worker use the same store contract. Legacy Electron
OS-store state and branch-created keytar state are intentionally not migrated
or deleted.

The Desktop pairing server stores claimed recovery snapshots through this
encrypted store. Snapshots retain the exact canonical signed request, device
label, approval state, bounded expiry, and used encrypted message IDs. Listener
startup restores valid claimed snapshots before binding, then the Desktop
manager resumes their automatic enrollment. Completed enrollment remains
replayable for one bounded ten-minute final-completion window; client retries
use fresh message IDs. Recovery and final replay are bounded, not indefinite.

Capability-based Personal Device pairing is present in the child handoff. Its
one-time invitation link is the enrollment capability, with no ordinary
short-code comparison or Authority approval step. A claimed request retains its
exact binding through disconnect for bounded post-expiry durable-commit recovery;
new or non-exact exchanges are rejected and recovery eventually expires. This
does not change the private/Tailscale HTTP transport boundary, encrypted local
PDS store, or stdin/FD-only guidance for headless link input.

Current static/unit validation also passes: Desktop full package suite (77
files / 726 tests), `@koed/koed-server` full package suite (42 files / 568
tests), `@koed/shared` full package suite (51 files / 520 tests), the API
scoped-local-credential boundary test, Desktop and server TypeScript checks,
and Prettier for changed handoff, running, and configuration docs. These checks
do not prove successful Desktop or SSH enrollment, encrypted persistence across
an OS crash, or live crash/restart behavior.

Root `pnpm verify` remains blocked until usable `DATABASE_URL` and Postgres are
available. Studio live Tailscale pairing remains blocked; no live result is
claimed.

## Decisions

- Remove the requirement for `keytar`/Keychain/Secret Service access from headless PDS operation.
- Use a Koed-owned application-managed secret store with strict filesystem permissions and atomic writes.
- Do not write secrets to `.env`, command arguments, logs, queue payloads, or world/group-readable files.
- Electron and headless should share the same application-facing PDS secret-store contract and documented state model.
- Use one application-managed filesystem secret store for Electron and headless operation. The implementation may use an application-level encrypted envelope, but any key-management design must remain headless-compatible and must not recreate an OS-unlock prerequisite. A T3Code-style `0700` directory with `0600` files is the baseline local-trust requirement.
- Remove `safeStorage`/`keytar`/OS credential-store dependencies from the PDS storage path rather than silently falling back between platform-specific providers.
- Keep PDS storage behavior consistent across foreground, background, Electron, and SSH-launched server processes.
- Do not revive server-side LLM synthesis or change unrelated domain boundaries.

## Architectural parent: Koed Simple Server Proposal

The Linear document **Koed Simple Server Proposal** is the architectural parent for this work. It is not part of this focused storage implementation and should be tracked as a larger follow-on/cross-cutting effort.

- It defines one `koed-server` package supporting integrated, edge, and authority compositions; this favors one storage contract rather than Electron-only and headless-only implementations.
- It makes local storage location a deployment input and requires fresh `KOED_HOME`/database cutover in alpha, with no migration of existing credentials or enrollment state. This permits an explicit clean-break storage change, provided startup/reset behavior is documented.
- It lists `key provider` and application-layer encryption as separate Operator configuration concerns. Do not conflate the authority's application-layer encryption key provider with the local PDS runtime-secret store.
- It requires bootstrap service credentials and token pepper to use a supported secret store and says ordinary configuration files must not contain reusable credentials. A dedicated permissioned application secret directory is compatible if treated as secret-store state, not public configuration.
- Its statement that Connected setup uses the operating-system trust store by default concerns TLS certificate trust, not necessarily credential storage.

The implementation agent should reconcile this change with the proposal's configuration schema and fresh-install/reset rules rather than reintroducing deployment profiles. The storage slice should land with a clean seam that the later two-mode/composition work can consume; do not attempt the full topology, authority-transfer, retrieval-fallback, or deployment-profile cutover in this task.

## Acceptance criteria

- [x] Standalone/headless `koed-server` can perform PDS secret get/put/delete without `keytar`, Keychain, D-Bus, Electron, or an interactive session.
- [ ] SSH-only pairing completes on studio using `personal-sync join redeem --link-stdin` or `--link-fd`.
- [x] Electron/Desktop and headless use the same application-managed secret-store contract and documented state model.
- [x] PDS secrets never appear in process arguments, environment variables, logs, queue payloads, or ordinary world/group-readable files.
- [x] Store directory/file permissions, atomic writes, cleanup, reference validation, size limits, and restart behavior are covered by shared store and provider tests; platform crash injection remains pending. Pairing recovery ordering, startup resume, bounded final replay, and failure cleanup are covered by unit/regression tests only.
- [x] Existing Electron `pds-secrets.json` state and branch-created keytar state are handled deliberately through documented non-migration and fresh-`KOED_HOME` reset behavior.
- [x] Tailscale/private-network pairing transport remains present with concrete
      private-interface binding; wildcard/public listener binding is rejected.
- [x] `/docs` documentation reflects provider/storage model, claimed recovery,
      startup resume, bounded final replay, loopback-scoped local auth, transient
      FD handling, capability pairing, and SSH setup.
- [ ] Root DB-backed verification and Studio pairing E2E pass. Package-scoped
      static/unit tests, Desktop/server typechecks, and changed-doc Prettier
      checks pass as recorded above; no live crash E2E is claimed.

## Constraints

- Read `CONTEXT.md` before changing domain terminology or user-facing wording.
- Keep pairing links out of shell history/process listings for CLI redemption by
  requiring stdin/FD input. Desktop paste or QR scan is preferred; macOS normally
  delivers `koed-pair://` through Electron `open-url`, while Windows/Linux may
  deliver it in argv through OS protocol activation. Do not log or persist it.
- Do not put PDS keys in `.env` or pass them via CLI/environment values.
- Do not reintroduce a platform-dependent provider split or silently change storage models between Electron and headless operation.
- Work in the current Koed workspace; do not create a worktree unless explicitly requested.
- Do not commit or push unless separately requested.
