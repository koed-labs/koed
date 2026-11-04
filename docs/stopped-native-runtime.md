# Stopped native runtime operations

Native runtime changes require stopped Koed. The Operator controls service
shutdown and startup. An installation must not stop services, restart services,
reclaim stale locks, or reverse an activated selection automatically.

## Lifecycle boundary

`withStoppedRuntime` in `packages/koed-server/src/generation-lifecycle.ts`
holds the existing `generation-lifecycle.lock` for one awaited operation.
This is the same lock that a packaged generation holds throughout execution.
Lock contention refuses immediately. The boundary preserves the existing
generation owner check, including Desktop ownership evidence.

The strict observer distinguishes stopped, running, and uncertain state.
It inspects the supervisor lock, generation pin, recorded child PIDs, Postgres
process lock, and a bounded process listing. A missing supervisor lock alone
does not establish stopped state. Permission failures and incomplete discovery
produce uncertain state. The observer never signals a process or removes state.

The callback runs only after ownership and stopped state pass under the lock.
It must bound and await every native probe and terminate its test processes
before returning or throwing. A timer must not release the lock while the
callback still performs work. The boundary releases its own lock on success
or failure and preserves a lock whose ownership record changed.

The frequent read-only status observer remains separate. Existing startup,
generation pinning, shutdown, and Desktop behavior remain unchanged by this
prefactor. The release installer and source-mode selection integration are
later tickets. This boundary alone does not expose a new runtime provider.

## Operator recovery

If Koed runs, use its normal `koed stop` command for the same `KOED_HOME`.
If another lifecycle command runs, let it finish before retrying. Do not
remove its lock to bypass contention.

After an interrupted command, inspect the lock owner record, supervisor state,
generation pin, recorded process IDs, and Postgres `postmaster.pid`. Establish
that the matching supervisor and all native children exited. PID absence alone
does not resolve unreadable identity evidence or an incomplete process listing.
If this cannot be established, leave the files intact and investigate.

Once stopped state is independently established, preserve a copy of the stale
evidence before removing only the confirmed stale lifecycle or supervisor
record. Use Postgres recovery procedures for a retained `postmaster.pid`.
Do not remove payloads, component selections, models, or database files.
Run the original operation again, then start Koed explicitly when ready.

## Focused validation

Run from the checkout root in an environment that permits process inspection:

```bash
pnpm exec vitest run packages/koed-server/src/stopped-runtime.test.ts packages/koed-server/src/runtime-lifecycle.test.ts packages/koed-server/src/generation-lifecycle.test.ts
pnpm --filter @koed-labs/server typecheck
```

The regression cases cover retained generation exclusion, owner mismatch,
normal and exceptional lock release, stale locks, orphaned children, missing
supervisor state, reused PIDs, unreadable state, and native discovery failure.
These tests require no CUDA device, production database, or running Koed.
