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

The explicit Linux release installer checks ownership and stopped state before staging.
It repeats those checks under the same lock before activation. Source starts using
the native store resolve one verified selection while their supervisor holds
the lock. Packaged starts do so while their generation pin holds the lock.

For a CUDA selection the installer runs the packaged CPU/GPU validator inside
the activation lock. A failed probe leaves the previous selection active.
The validator also runs independently with `koed runtime validate --runtime-root
<trusted-directory> --require-model --json`. It uses the same stopped-state and
owner checks, a private temporary directory and Unix sockets, and a two-minute
deadline. Cancellation kills the probe process groups before releasing the lock.

For a selected release core, the supervisor starts the Embedding Service in a
private process group. Explicit shutdown signals that group, including its
llama-server child. Shutdown waits for the whole group to drain, not only its
leader, and kills any member still running at the deadline. The stop command
gives the supervisor time to finish its bounded child cleanup. If the supervisor
does not exit, the fallback signals the recorded Embedding Service group only while
its leader still has the process identity recorded at spawn. It reports any
remaining native process evidence.

## Operator recovery

If Koed runs, use its normal `koed stop` command for the same `KOED_HOME`.
If another lifecycle command runs, let it finish before retrying. Do not
remove its lock to bypass contention.

A crashed or killed supervisor can leave its lock or generation pin behind.
`koed stop` never signals the children of a supervisor that has exited. When
every recorded child has also exited, and no Postgres lock or process that
references the native runtime remains, `koed stop` and stopped runtime operations
remove the stale records. They do so under the lifecycle lock, which supervisor
start also takes to reclaim a stale lock, and only if each record is unchanged.
A live recorded child, a record whose process is alive with a different identity,
or unreadable state still requires Operator recovery.

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

If integrity checks identify a damaged native payload, establish stopped state
first. Preserve `KOED_HOME/runtime/native` by moving that directory to a separate
backup location. Keep the two fixed entry links, models, components, and Postgres
data in place. From a Control Plane containing the reviewed pin, run:

```bash
koed runtime install --provider release --dependency-mode bundled-local
koed runtime status --provider release --json
```

If an entry link points elsewhere, inspect ownership before making changes.
Keep using the existing provider for Homebrew or Desktop installations.

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
