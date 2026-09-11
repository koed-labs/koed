# Handoff: Unify PDS Secret Storage Across Electron and Headless CLI

## Task

Refactor Koed Personal Device Sync (PDS) secret storage to use one consistent Koed-owned application-managed local secret-store model across Electron/Desktop and standalone/headless `koed-server` CLI.

Remove the current split where Electron uses its Desktop/platform `safeStorage` bridge and headless CLI uses `keytar`/native OS credential storage. The PDS store must not require Keychain, Credential Manager, Secret Service/KWallet, D-Bus, Electron, or an interactive session on either path. Preserve Tailscale pairing and SSH-only `personal-sync join redeem`.

This document is a handoff for a future implementation agent. Do not treat it as completed work.

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

- `packages/koed-server/src/native-secret-provider.ts` — newly added `keytar` provider and automatic headless provider wiring; likely replace/remove.
- `packages/koed-server/src/personal-sync.ts` — provider dispatch, PDS runtime secret get/put/delete, pending material, and SSH pairing redemption.
- `packages/koed-server/src/start.ts` — currently injects bundled native/headless provider into local service environments.
- `packages/koed-server/src/cli.ts` — currently exposes `secret-provider get|put|delete` and pairing CLI commands.
- `packages/koed-server/src/native-secret-provider.test.ts` — tests for the keytar provider; replace with application-managed store tests.
- `packages/koed-server/src/personal-sync.test.ts` — PDS provider and SSH pairing tests.
- `apps/desktop/src/pds-secure-provider.ts` — existing Electron `safeStorage`-backed Desktop store; replace its PDS storage role with the common application-managed store.
- `apps/desktop/src/pds-secret-bridge.ts` and `apps/desktop/src/pds-secret-bridge-provider.ts` — Desktop-to-child provider bridge; remove or simplify if no longer needed for PDS secret storage.
- `apps/desktop/src/koed-server/manager.ts` — Desktop server/provider environment setup.
- `packages/koed-server/package.json` — currently has the branch-added `keytar` dependency.
- `pnpm-lock.yaml` and `pnpm-workspace.yaml` — currently include `keytar` and its build permission.
- `docs/configuration.md` — PDS provider configuration.
- `docs/running-koed.md` — SSH pairing and operational guidance.
- `docs/service-sequence-overview.md` — provider/service-flow documentation.
- `CONTEXT.md`, `AGENTS.md`, `TODO.md` — canonical terminology, security/project constraints, and backlog.

## Current implementation state

Already implemented and tested on this branch:

- Tailscale private-network support (`100.64.0.0/10`).
- SSH-only `personal-sync join redeem`.
- Pairing link input via `--link`, `--link-stdin`, and `--link-fd`.
- Encrypted application-level pairing transport.
- Automatic local API URL resolution for SSH redemption.
- A `keytar`-based native provider for standalone/headless operation.
- CLI `secret-provider get|put|delete` commands.

Validation before this handoff:

- Koed server tests: 552 passed.
- Server typecheck, build, and Prettier checks passed.
- Studio runtime services are healthy; overall status has an unrelated API-token HTTP 429 diagnostic.
- Studio `keytar`/`security` writes still fail from SSH with `User interaction is not allowed`.

T3Code was inspected at `/Users/jedd/.cache/checkouts/github.com/pingdotgg/t3code`. Its `apps/server/src/auth/ServerSecretStore.ts` creates a `0700` secrets directory, stores `0600` files, writes atomically, and reads directly from headless processes. It does not depend on `keytar` for server secret storage.

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

- [ ] Standalone/headless `koed-server` can perform PDS secret get/put/delete without `keytar`, Keychain, D-Bus, Electron, or an interactive session.
- [ ] SSH-only pairing completes on studio using `personal-sync join redeem --link-stdin` or `--link-fd`.
- [ ] Electron/Desktop and headless use the same application-managed secret-store contract and documented state model.
- [ ] PDS secrets never appear in process arguments, environment variables, logs, queue payloads, or ordinary world/group-readable files.
- [ ] Store directory/file permissions, atomic writes, cleanup, reference validation, size limits, and crash/restart behavior are tested.
- [ ] Existing Electron `pds-secrets.json` state and any branch-created keytar state are handled deliberately. The Simple Server Proposal permits a fresh alpha `KOED_HOME`/database cutover without credential or enrollment migration, so a documented reset/non-migration path is acceptable; do not silently discard state.
- [ ] Tailscale pairing behavior remains intact.
- [ ] `/docs` documentation reflects the new provider/storage model and SSH setup.
- [ ] Relevant tests, typechecks, builds, and Prettier checks pass.

## Constraints

- Read `CONTEXT.md` before changing domain terminology or user-facing wording.
- Keep pairing links out of shell history/process listings by recommending stdin/FD input.
- Do not put PDS keys in `.env` or pass them via CLI/environment values.
- Do not reintroduce a platform-dependent provider split or silently change storage models between Electron and headless operation.
- Work in the current Koed workspace; do not create a worktree unless explicitly requested.
- Do not commit or push unless separately requested.
