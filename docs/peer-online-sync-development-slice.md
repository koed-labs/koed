# Peer-online sync development slice

The test-only peer transport slice exercises signed PDS lifecycle fixtures and in-process checkpoint delivery between two distinct PostgreSQL databases. It is not a production peer-online protocol or deployment.

The fixture signs a genesis, an add-device statement with an authorized encrypted key bundle, and a tombstone statement. It verifies the statement chain and bundle, decrypts the bundle for its recipients, and issues test membership certificates at the fixture head. A later signed tombstone can be used to test a matching deletion floor. Lifecycle authorization, the Authority keys, admission, activation and certificates are test fixtures, not a decentralized governance implementation. The fixture does not exercise real pairing or key rotation.

The in-process sender uses the existing source checkpoint, manifest, package and retention APIs. The receiver verifies and decrypts the package, checks the fixture's authenticated floors, retains it through the inbox, verifies the repository assignment, and invokes repository checkpoint materialization using the worker helper `pdsCheckpointMaterializationSource`. The harness substitutes transport, in-memory floor delivery, package-specific inbox leasing, and scheduling; its floor check is not proof that the production worker authenticates or applies floors the same way. Inbox retries in this test are explicitly driven by the harness, not by a production peer scheduler. Duplicate delivery exercises the inbox's idempotent short-circuit; it does not re-run repository materialization.

The tests do not establish network authentication or replay resistance, real network delivery, worker orchestration, Capture Hook behavior, Projection or Recall, restart recovery, pairing, group-wide deletion convergence, or production readiness. They do not change the accepted PDS V1 profile. The databases and keys are test-only.

Run the integration tests against **two distinct disposable databases**, with Node 24 and dependencies installed:

```sh
P1_SOURCE_ORIGIN_DATABASE_URL=postgresql:///peer_origin \
P1_SOURCE_RECEIVER_DATABASE_URL=postgresql:///peer_receiver \
pnpm --filter @koed/db exec vitest run tests/personal-peer-lifecycle.test.ts tests/personal-peer-online-sync.test.ts --no-file-parallelism
```

The databases must have different database names, even if they are on different servers. The database suite skips if either URL is absent; a skipped run is not validation. Migrations are applied to both databases, and test rows are retained; do not point it at production or valued data.

## Offline session adapter

An internal, unregistered adapter composes an injected authenticated session context, channel, receiver and codec for offline tests only. It starts no listener, socket, database pool or runtime service and defines no production wire codec. Frames are processed serially; only receiver-returned accepted or duplicate results can produce an ACK. Codec implementations must reject unknown wire fields and wire-supplied session context. A completed channel write does not establish remote delivery. Its structural compatibility assertions require the repository-root `pnpm typecheck:test`; running Vitest alone does not typecheck them.

The session's `done` and `close()` expose a non-ACK receiver status; other failures are reported through `onError`. Shutdown closes the channel and waits for in-flight receiver and send operations to settle; it does not cancel or roll back a receiver transaction and may wait indefinitely, including when channel close throws without settling an operation. An injected channel may supply a unique `localCloseError` identity reserved exclusively for operations cancelled by local close; only that identity from a pending channel operation after close is suppressed. Channels without this contract, including the existing message channel, cannot reliably distinguish local-close rejection from transport failure, so both are reported. Receiver failures are always reported. The channel has no independent disconnect notification while a receiver is running: its owner must signal observed shutdown, and otherwise a send may fail after commit. Retry after an uncertain delivery may yield a duplicate, subject to current receiver checks. Test-only codec examples do not establish a production wire schema or validate other codecs.

Live integration remains gated on a reviewed wire schema and limits, aggregate resource budgets, backpressure and timeouts, bounded shutdown escalation, trusted custody, deletion reconciliation, cross-writer and read fencing, real TLS and database tests, and independent security review. This adapter does not establish sync availability or production readiness.

## Membership history experiment

A separate, test-only peer membership model exercises a supplied trust anchor, signed history, authorization at each parent, and fail-closed fork and resource-limit latches. It is not wired into the PDS lifecycle fixture above or into production sync. A disposable PostgreSQL fixture tests replay through a fresh connection pool, transaction rollback, and concurrent sibling writers; it does not test process or database crashes, actual pairing, sync fencing, key distribution, or recovery. The test fixture creates and drops its own uniquely named schema, not production tables.

```sh
pnpm --filter @koed/shared exec vitest run src/peer-membership-history.test.ts
PEER_MEMBERSHIP_EVIDENCE_DATABASE_URL=postgresql:///peer_evidence_disposable \
  pnpm --filter @koed/db exec vitest run tests/peer-membership-evidence.test.ts
```

Use a disposable database. The PostgreSQL test skips without its environment variable; a skipped run does not verify persistence.
