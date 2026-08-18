# Running Koed

## Approval Activity remediation

After upgrading an existing database, an Operator can inventory legacy
approval-derived semantic data without mutation:

```bash
pnpm --filter @koed/db approval-activity:inventory
```

The bounded report is stable across repeated runs and counts affected Memory
Events, embeddings and queued work, LCM derivatives, semantic replicas, and
snapshot or continuous shares. Ambiguous scopes stop correction and require
Operator review. After reviewing the inventory, apply the idempotent correction:

```bash
pnpm --filter @koed/db approval-activity:correct
```

Correction removes semantic derivatives, schedules eligible rebuild/deletion
work, and revokes only deterministically affected snapshot shares. It preserves
the owner Approval Activity timeline and byte-exact Conversation Source
Artifacts, access grants, exports, and Fork Snapshots.

> [!IMPORTANT]  
> Codex, Claude Code, and Pi are supported AI Client integrations. See client-specific integration guides for setup and limitations.

Koed's server deployment unit is `koed-server` plus dependencies. Internally,
`koed-server` supervises API, Worker, and the local Transcript Watcher, and connects
to the configured Embedding Service. Postgres with pgvector stores Users, API
Tokens, Memory Events, Memory Nodes, embeddings, and Capture Policies. Redis
backs BullMQ queues when `WORK_QUEUE_BACKEND=bullmq`; the Postgres-backed local
queue is used when `WORK_QUEUE_BACKEND=local`.

The README Quickstart is the supported first-time path for basic local use: one
bundled-local setup that avoids Docker, external Postgres, and external Redis.
This document covers advanced running modes, development fallbacks, manual
control-plane commands, and smoke workflows.

In source checkouts, `koed-server` defaults to external dependency mode unless
`KOED_DEPENDENCY_MODE=bundled-local` is set. In external mode it connects to
Operator-managed Postgres, Redis/BullMQ, and Embedding Service endpoints; it
does not start or stop Docker Compose dependencies.
For server/private VPS terminology and migration notes, see
[server-deployment-boundary.md](server-deployment-boundary.md).

## Manual control-plane commands

`pnpm desktop:start` opens Koed Desktop, which auto-starts `koed-server`, runs
AI Client bootstrap when needed, and keeps the startup screen visible until the
system is ready.

Desktop creates and loads its main window before it resumes the managed local
`koed-server`. Platform secret-provider initialization runs in the background
startup path after the window exists and before the runtime resumes. A blocked
or interactive operating-system credential provider therefore cannot leave the
User with no application window. A fresh or incomplete setup opens the guided
setup without silently installing runtime or model assets. After explicit User
confirmation, Desktop checks and runs the package, native runtime, embedding
model, local services, AI Client integration, and final verification stages in
order. Codex remains part of first-run setup. Desktop also detects Claude Code
and Pi from their executable or global profile files, lists detected clients on
the setup page, and configures each one automatically. A detected client that
is installed but unsupported or unauthenticated stops setup with its actionable
client-specific error. Completed stages are skipped. Only the active stage is shown as running,
model download progress comes from transferred artifact bytes, and a failure
stops the workflow with a retry that re-inspects local state. The automatic
resume wait is bounded so broken local runtime state remains diagnosable from
the app.

The normal Desktop surface is a product UI rather than an operations dashboard.
It keeps successful setup details collapsed, surfaces remediation only when
needed, and leaves Personal available during Team outages. Team enrollment,
reconnect, backend change, and failure-recovery behavior is documented in
[Koed Desktop](desktop-ui.md). Advanced Diagnostics remains available for
Operator troubleshooting without exposing reusable credentials to the
renderer.

`koed-server` owns `KOED_HOME`, runs API and Worker as supervised
local app processes, and records runtime state under `KOED_HOME/run`. In
external dependency mode, Docker Compose or another dependency launcher is
Operator-managed infrastructure.

Check service state or stop/restart supervised local processes from any headless
shell:

```bash
node packages/koed-server/dist/cli.js status --json
node packages/koed-server/dist/cli.js doctor --json
node packages/koed-server/dist/cli.js identity status --json
node packages/koed-server/dist/cli.js identity rotate --json
node packages/koed-server/dist/cli.js start --daemon --json
node packages/koed-server/dist/cli.js stop --json
node packages/koed-server/dist/cli.js restart --json
```

`start --daemon --json` starts a detached `koed-server start` supervisor and returns machine-readable startup intent for Desktop and scripts. One live supervisor owns each `KOED_HOME`: startup acquires an atomic lock before allocating automatic ports or starting dependencies, and a concurrent start reuses the live supervisor instead of rewriting `config/local-ports.json`. Stale locks are reclaimed after their owning process exits. Bundled-local cleanup stops native Postgres only when the current startup actually started it, so a failed concurrent or recovery attempt cannot stop another live supervisor's database.

Startup and `status --json` also inspect clone-safe local identity without blocking local services. JSON includes redacted `deviceIdentity` with opaque deployment/device IDs, health, remote-operation gate, and platform-protection level; it never contains raw host proof, proof references, paths, fingerprints, API Tokens, or upstream credentials. First boot records durable bootstrap state under `KOED_HOME/config` before proof/state writes, so faults never silently regenerate identity from disposable `run` state. Missing, malformed, mismatched, or unsafe proof/state leaves local capture and Recall available but blocks upstream enrollment, Cross-Identity Sync, Team local-edge proxying, and other remote work. Copying identity to another same-host `KOED_HOME` path fails proof binding. Native Windows reports limited protection and remote work fails closed. A perfect full-machine clone or restored image at same canonical path remains locally indistinguishable; remote collision detection and explicit re-enrollment are required.

Use `identity rotate --json` only for explicit repair/replacement: it preserves deployment ID, creates a new device ID/proof, preserves local Memory, disables local routes, and invalidates local enrollment references where possible. Koed does not self-revoke remote credentials without authorized upstream flow. If remote revocation remains pending, rotation stays `repair_required` with redacted `pendingRemoteRevocation` state and never reports healthy; revoke remotely, run `identity rotate` again as Operator acknowledgement, then re-enroll.

`stop` is idempotent. Missing/stale process IDs are reported in JSON but do not fail the command. After managed services stop, the CLI verifies the runtime PID against the supervisor lock and writes an identity-bound stop request containing the PID and supervisor start time. The matching supervisor consumes that request and exits itself; the stop path never sends signals to a supervisor based only on a recorded PID. Runtime state is removed only when its identity is unchanged, and a terminating supervisor removes the shared lock only while it still owns that lock. `restart --json` runs the same stop lifecycle, starts a detached `koed-server start` supervisor, and returns machine-readable JSON without streaming startup logs. Stop order is Transcript Watcher, Worker, API, then native Embedding Service and native Postgres via `pg_ctl stop -D <dataDir> -m fast` in bundled-local mode. It does not stop Docker Compose. External dependency mode does not stop Operator-managed Postgres, Redis, or Embedding Service.

API, Worker, and the bundled-local native Embedding Service are
essential managed children. After startup, an unexpected exit or process error
from any one of them makes the supervisor stop the remaining managed children,
stop owned bundled-local dependencies, remove its runtime ownership state, and
exit nonzero. The supervisor does not restart individual children in-process;
the deployment supervisor restarts the complete service set. SIGINT, SIGTERM,
and an identity-bound `koed-server stop` request use the same idempotent cleanup
path and exit cleanly.

In a source checkout, the supervisor launches the built API and Worker
Node entry points directly. Recorded process IDs therefore identify the service
processes themselves, so stop and restart do not leave package-manager child
processes listening on Koed ports.

Local upstream enrollment orchestration is exposed as machine-readable
control-plane state for Desktop and headless scripts:

```bash
node packages/koed-server/dist/cli.js upstream enroll start --id team-vps --json
node packages/koed-server/dist/cli.js upstream enroll status --id team-vps --json
node packages/koed-server/dist/cli.js upstream activate --id team-vps --json
node packages/koed-server/dist/cli.js upstream enroll cancel --id team-vps --json
node packages/koed-server/dist/cli.js upstream disconnect --id team-vps --json
```

Desktop collaboration is carried by a separate authenticated local broker
started and supervised with the local `koed-server`. Electron main launches the
broker command internally and bridges its typed protocol to the allowlisted
preload API; it is not an Operator-facing network service. The broker owns the
active upstream connection, capability refresh, subscriptions, durable cursors,
replay, reconnect, and protected Team-state clearing. Desktop remains usable
for Personal notes, Personal channels, and Personal Memory when no Team backend
is enrolled or the remote backend is unavailable.

API and Worker must receive the same `KOED_TEAM_COLLABORATION_ENABLED` value.
Changing it requires restarting both processes. Disabling it removes Team
capabilities and Team routes/jobs while retaining Personal collaboration and
Personal Memory. See [Configuration](configuration.md) for the exact disabled
surface and required collaboration secrets. Desktop-managed local edges default
the shared value to `true`; standalone server deployments remain disabled until
the Operator enables them explicitly.

`upstream enroll start` requires a registered upstream backend with fresh
validated capabilities and at least one explicitly enabled route-policy family.
It records non-secret local state under `KOED_HOME/run` and reports the next
browser action. It does not create API Tokens or write reusable device secrets
to ordinary config. Instead it creates a short-lived upstream browser approval
challenge, stores the pending local device secret in the encrypted
`KOED_HOME/secrets` credential store, and records only a `keychain://...`
reference in config. `upstream enroll status` validates the approved credential
against the upstream backend before marking the local backend credential
configured. Koed Desktop performs this reconciliation automatically while an
enrollment is pending and shows the activation URL as a manual fallback when
Linux/WSL host-browser integration is delayed or unavailable. `upstream
activate` explicitly selects the enrolled backend used for remote routing in
headless operation; enrollment alone does not replace an existing active
backend. `upstream disconnect` disables local upstream route families and marks the local enrollment
state revoked. These local mutations use a per-backend inter-process lock, with
remote requests kept outside the locked mutation phase. Browser approval and
upstream-side device credential revocation remain browser/session-mediated
local-edge flows.

## Personal Device Sync local data plane

PDS local source publication is opt-in. Browser-authenticated PDS close/status/
retry/pause routes require Authority, envelope encryption, configured secret
reference runtime, relay, and current worker heartbeat. Headless runtime uses
Operator-managed secret reference; Desktop host installs keychain adapter. No
raw environment/config or API Token can supply group/private keys. Missing
provider, limited Desktop adapter, expired authority context, or package
incompatibility disables PDS transfer only; capture and Recall continue locally.

Close locks Session, exact ordered items, policy/pause state, and origin sequence
in one transaction. Crypto/envelope failure rolls all rows and sequence allocation
back. Publication pause is durable and rechecked before relay network action;
resume is explicit. Worker leases use fencing, bounded exponential retry, and
quarantine permanent crypto/policy failures. Do not edit or append a closed
source Session; start a new Captured Session. Replica source is read-only. Check local status through
`GET /v1/personal-device-sync/groups/:groupId/local-status`; status is redacted
and exposes only state counts/readiness, never package content, fingerprints,
paths, or key references.

### Personal Sync control commands

`koed-server personal-sync` is bounded browser-session control-plane client;
Authority owns group, policy, membership, current head, activation, relay, and
worker outcome. Commands never report local enable/revoke success. Set only
`PDS_CONTROL_URL` plus `PDS_BROWSER_SESSION_FD` (FD number, not session value).
API Tokens and legacy credentials are rejected.

```bash
node packages/koed-server/dist/cli.js personal-sync status --json
node packages/koed-server/dist/cli.js personal-sync join request \
  --group-id "pds_group_id" --json
node packages/koed-server/dist/cli.js personal-sync policy pause \
  --group-id "pds_group_id" --json
node packages/koed-server/dist/cli.js personal-sync policy resume \
  --group-id "pds_group_id" --json
node packages/koed-server/dist/cli.js personal-sync replica status \
  --group-id "pds_group_id" --json
node packages/koed-server/dist/cli.js personal-sync recovery-kit verify \
  --recovery-kit "$HOME/koed-recovery-kit.json" --password-fd 3 --json
```

Pairing stores only redacted backend request IDs locally and shows challenge ID
and short code. It is never discarded. Active-device, recovery, revoke, and
conflict actions require exact pre-built signed transition data through
protected FDs; Authority validates CAS/current head, countersigns, and exposes
durable pending activation status. Arbitrary device IDs cannot succeed.

`--password` is rejected. Pipe password bytes through stdin or supply a file
descriptor; never put recovery passwords in arguments, environment, logs, or
config. Recovery-kit descriptor is strict scrypt/AES-256-GCM with canonical
metadata AAD, fixed salt/nonce/tag lengths, 0600 atomic fsync write, and
symlink refusal. Desktop uses a local-only authenticated bridge to its
platform-backed provider: Keychain on macOS, DPAPI on native Windows, verified
Secret Service/KWallet on Linux, and a native Windows-host DPAPI helper for WSL
where available.
Electron's insecure `basic_text` fallback is rejected. Missing secure storage
disables PDS only; Desktop never writes PDS secrets to plaintext state,
configuration, or environment. Association and Remote Account Links alone
synchronize nothing.

### Same-network Desktop pairing

After first-device Personal Device Group setup, open **Devices** on the
Authority-hosting installation and choose **Pair another device**. Koed shows a
QR code, copyable private-network link, eight-character comparison code, and
expiry. The second Desktop may scan the QR, open the `koed-pair://` handoff, or
paste the link under **Join with link**. Confirm that both devices show the same
short code, then approve on the Authority-hosting installation. Joined devices
are symmetric Personal Memory replicas, but V1 does not copy the Authority key
or offer another invitation from those replicas.

Pairing requires both devices to reach the inviting installation's private IPv4
address on TCP port `3310`. The invitation lasts ten minutes, is invalidated
after completion, and never transmits its secret in HTTP. Koed encrypts the
ceremony at the application layer and then uses the existing signed PDS
membership and encrypted relay protocol. Do not expose port `3310` to the
public internet.

After enrollment, Desktop keeps that private-network gateway available for
certificate-authenticated encrypted replication and restores it when local
services resume. Invitation routes remain invalidated after use. If the
gateway cannot bind, Devices status reports the fault; Personal capture and
Recall continue locally until replication connectivity is restored.

For API-first validation, run `pnpm pds-fixture:validate` with `DATABASE_URL`
set so its PostgreSQL stages execute. Against an isolated local-personal API
whose test User has no existing Personal Device Group, run:

```bash
PDS_E2E_CONTROL_URL=http://127.0.0.1:<api-port> \
PDS_E2E_BROWSER_COOKIE='<session-cookie>' \
pnpm pds-pairing:e2e
```

For the required two-database enrollment/recovery gate, run two isolated
`local_personal` APIs and additionally provide the joining API and its own local
authentication:

```bash
PDS_E2E_CONTROL_URL=http://127.0.0.1:<device-a-api-port> \
PDS_E2E_BROWSER_COOKIE='<device-a-session-cookie>' \
PDS_E2E_JOINING_CONTROL_URL=http://127.0.0.1:<device-b-api-port> \
PDS_E2E_JOINING_BROWSER_COOKIE='<device-b-session-cookie>' \
pnpm pds-pairing:e2e
```

The command rejects identical API origins. It verifies that the signed joining
state is independently reconciled and retained by Device B before its protected
runtime is rebound to Device B's local User.

An explicitly disposable API with public test registration may use
`PDS_E2E_ALLOW_REGISTER=1` instead of a supplied cookie. Never enable that
switch against a real User deployment. The command proves real Authority API
genesis, encrypted LAN exchange, signed active-device approval, epoch-2
activation on two isolated device identities, source refresh, relay binding,
optional second-database local reconciliation, and one-time invitation
invalidation. It emits no credentials. Desktop validation then proves the
QR/link handoff, source-package data plane, and rendered states.

Run `pnpm pds-fixture:validate` for deterministic shared-protocol crypto
vectors plus control/recovery lifecycle tests. Fixture matrix explicitly labels
DB-required Authority/relay/materialization and Projection/Recall cases rather
than claiming in-process coverage for those seams.

### Joined Personal validation

Against a clean, healthy bundled-local Personal stack, run the joined capture,
Projection, embedding, LCM expansion, and Memory Answer detail-mode smoke:

```bash
MEMORY_API_URL=http://127.0.0.1:<api-port> \
MEMORY_API_TOKEN='<personal-api-token>' \
DATABASE_URL='postgres://...' \
pnpm smoke:personal-joined
```

This executes the live LCM smoke first, including a real rollup expansion back
to source Memory Events, then calls the MCP `memory_answer` tool with
`answer_only`, `with_citations`, and `with_evidence`. Local Codex authentication,
the bundled embedding model, and the native PostgreSQL client remain live
prerequisites.

For two-device data-plane validation, first pair two distinct, running
bundled-local Personal installations and confirm both PDS workers are ready.
Then run:

```bash
PDS_SMOKE_DEVICE_A_URL=http://127.0.0.1:<device-a-api-port> \
PDS_SMOKE_DEVICE_B_URL=http://127.0.0.1:<device-b-api-port> \
PDS_SMOKE_DEVICE_A_API_TOKEN='<device-a-personal-token>' \
PDS_SMOKE_DEVICE_B_API_TOKEN='<device-b-personal-token>' \
PDS_SMOKE_DEVICE_A_BROWSER_COOKIE='<device-a-session-cookie>' \
PDS_SMOKE_DEVICE_B_DATABASE_URL='postgres://...' \
PDS_SMOKE_GROUP_ID='<personal-device-group-id>' \
pnpm smoke:pds-replication
```

The command enables future-closed-session publication, captures and projects a
unique transcript-backed Personal source on Device A, closes it, and requires
Device B to materialize and semantically retrieve the marker. It subscribes to
Device B's durable `koed_pds_local_sync` PostgreSQL notification channel before
close and performs a post-listen durable check, so it does not poll. The
receiving database URL is used only for readiness notifications; retrieval is
verified through Device B's authenticated Memory API.

## Project metadata discovery

Headless and Desktop flows can discover local Project metadata before linking a
Project to a Team Workspace:

```bash
node packages/koed-server/dist/cli.js project discover --cwd "$PWD" --json
node packages/koed-server/dist/cli.js project show --cwd "$PWD" --json
node packages/koed-server/dist/cli.js project list --json
```

Project metadata is local matching/display data, not authorization. Discovery
stores raw local paths only under `KOED_HOME/config/projects.json`, strips
credentials from Git remotes, derives a device-local Project id, and retains
individual current and historical network remote aliases as non-authoritative
matching signals. Remote signals never select or authorize a Team Workspace;
explicit Project linking is authoritative. The Team Workspace id remains the
stable Team memory boundary.

Discovery inspects the supplied directory and its enclosing Git repository only;
it does not recursively discover child repositories, submodules, or monorepo
packages. Worktrees retain separate local Project ids while a salted Git
common-directory hash identifies worktrees backed by the same device-local Git
repository. Local-only repositories have no portable remote signal.

Captured Sessions adopt one unambiguous detected Personal Project immediately.
Ambiguous or signal-free captures remain `Unassigned`. Users can move a
Captured Session to another Personal Project in Desktop; that override remains
authoritative across later capture detection. Resetting returns assignment to
the latest automatic detection. Original capture candidates and source context
remain stored separately as immutable provenance. Effective assignment drives
Personal Memory grouping, counts, filters, and Project-scoped recall.

Personal Project assignment never creates, changes, resolves, or authorizes a
Team Workspace link. Team Workspace identity still comes only from explicit
Project linking, and Team access still requires Koed-owned Membership,
Workspace Access, and Share Grant authorization.

Personal Device Sync may use remote-alias overlap to associate local Project
contexts after both devices are active in the same Personal Device Group.
Remote aliases remain evidence only: they cannot authorize membership, merge
conflicting source histories silently, or create a Team Workspace link.
`project forget
--local-project-id <id>` removes the local Project record, including retained
remote-alias history.

## Cross-Identity Sync

Cross-Identity Sync is available only when the complete path is reported by
capabilities. Relationship creation runs on a `local_personal` or `developer`
source after explicit User consent and a validated upstream enrollment whose
device credential includes the `sync` operation family. Remote intake runs only
on `private_vps`, `team_self_hosted`, or `koed_managed_cloud` targets, except
for an isolated `developer` target explicitly enabled with
`KOED_DEVELOPER_TEAM_BACKEND_ENABLED=true`. That local-testing target still
requires application-layer encryption and a ready Cross-Identity Sync Worker.
Personal API Tokens and Capture Hooks cannot exercise this authority.

The source remains usable offline. Canonical changes accumulate in its durable
outbox and resume from the last acknowledged cursor when the target returns.
The target replica is read-only, and Team visibility still requires a separate
Workspace Share Grant after target processing reaches `ready`. Use authenticated
relationship status and redacted `/ops/status` sync metrics to diagnose queue
lag, retries, stale replicas, and failure classes; do not inspect encrypted
package rows as an operational workflow.

`hasSynchronizedRevision` means at least one target revision completed; it may
remain true while a newer revision is processing or after the sync relationship
is revoked. Use `syncState` for current transfer and freshness state. Stale,
processing, and partially available replicas are excluded from Recall. Sync
revocation stops future packages but does not revoke a Share Grant; Share Grant
revocation removes ordinary Team access, starts the independent grant-scoped
retention clock, and does not delete the owner-private target replica. An
untouched pending purge may be canceled by restoring the grant; claimed purge
work cannot be restored.

Target processing reconstructs authorized source records and creates fresh
target-owned embeddings with the target Embedding Service. Source vectors and
source-local Memory Node identities never cross the sync boundary. A complete
summary snapshot revision atomically replaces its predecessor; an authoritative
empty snapshot removes the prior target nodes and embeddings, while an
Event-only package leaves the acknowledged summary snapshot unchanged.

## Personal Device Sync V1

Browser-session PDS routes provide genesis, enrollment challenge, signed group
transitions, key-bundle acknowledgement, scoped status/log/certificate/bundle
retrieval, Personal Sync Policy, and Remote Account Link records. They require
configured Authority signer. Bearer API Tokens and `Koed-Device` credentials are
denied. Stale valid transitions return current signed head without rebasing or
freezing; governance freezes only on verified Authority equivocation or durable
integrity evidence. Membership epoch remains pending until every active device
acknowledges its bound encrypted bundle. Remote Account Link accepts opaque
proof token only and fails closed without server verifier. Tombstone and conflict-resolution routes accept only canonical, active-device or recovery-root authorized records and Authority-countersign final records. Browser sessions initiate requests but cannot authorize them; API Tokens and device credentials cannot initiate them. Device relay routes fetch opaque deletion floors before package service and submit signed tombstone ACKs only after durable local apply. Device revocation stops future key/package delivery, never erases plaintext already downloaded. PDS pause/revoke, local replica removal, Personal deletion, Team Share Grant revocation, Team retention, and hard purge remain separate operations.

Control plane and relay are separate from directed hosted Cross-Identity Sync
and its RSA envelopes. PDS remains `koed/pds/v1` only. Relay endpoints accept
only certificate-plus-request-proof device authentication, initialize a signed
transport, accept resumable encrypted chunks, commit checksums/digest without
decrypting, serve recipient mailbox/chunks, accept signed ACKs, and maintain
per-recipient/per-origin anti-entropy cursors. Policy defaults off and covers
only future closed Captured Sessions. Materialization, Projection, embedding,
and Recall remain device-local.

## KOED_HOME layout

`koed-server` keeps local state under `KOED_HOME`:

- `config/` for `server.json`, `local-ports.json`, `local-app-credential.json`,
  non-secret `device-identity.json`, local Project metadata, and Project-to-Team
  Workspace mappings
- `run/` for `koed-server.json`, `last-verification.json`, content-free
  Transcript Watcher wake state, identity bootstrap/lock state, upstream
  enrollment orchestration state, and supervisor state
- `status/` for aggregate diagnostic-only Transcript Watcher status
- `state/` for content-free Transcript Watcher activation state
- `logs/` for service logs, including `postgres.log`
- `data/` for native database files, including `data/postgres`
- `models/` for embedding and reranker model files
- `cache/` for installer metadata and downloaded artifact cache
- `runtime/` for bundled or packaged native runtime binaries

Packaged Desktop and headless local-personal flows both use this layout. Raw host proof stays in user-private platform state outside `KOED_HOME`; copying this layout alone intentionally cannot clone usable device identity. See [configuration](configuration.md#clone-safe-local-device-identity) for paths, POSIX permission checks, and Windows ACL limits.

Run Codex setup through the same surface after `koed-server start` has made the
API ready:

```bash
node packages/koed-server/dist/cli.js setup codex --json
```

## External dependency mode

Docker Compose is one optional way to provide external Postgres/pgvector,
Redis/queues, and the Embedding Service/model runtime. It is Operator-managed
infrastructure, not the local-personal happy path. Start Docker Desktop before
launching the Compose stack, then let `koed-server` connect to the service URLs:

```bash
pnpm env:setup
docker compose --env-file .env -f examples/docker-compose/docker-compose.yml up -d --build
pnpm desktop:start
```

Advanced Operators can provide the same URLs from `KOED_HOME/config/server.json`
instead of Docker Compose.

## Server / Private VPS Compose

For a server or private VPS style deployment, use the server Compose wrapper.
This runs `koed-server` as the application boundary plus private dependency
services on the Compose network:

```bash
pnpm env:setup
docker compose --env-file .env -f examples/server-compose/docker-compose.yml up -d --build
```

Keep the generated `.env` stable across Compose recreation and upgrades. The
server receives separate general and owner-private encryption provider settings,
along with persistent collaboration cursor and broker secrets, from that file.
Changing them requires an explicit rotation or rewrap operation; silently
regenerating them would make existing encrypted data or durable cursors unusable.

The server Compose wrapper sets `restart: unless-stopped` on `koed-server`,
Postgres, Redis, and the Embedding Service. Dependency containers therefore
recover after unexpected exits, and a nonzero supervisor exit restarts the
coherent API/Worker set. Manual `docker compose stop` and `docker
compose down` remain stopped until the Operator starts the stack again.

The default local test endpoint is `http://localhost:3300` for the API. In a
real private VPS or Team self-hosted deployment, put a reverse proxy/TLS
boundary in front of `koed-server` and keep
Postgres, Redis, and the Embedding Service private.

Because the database is private inside this wrapper, create API Tokens from
inside the server container:

```bash
docker compose --env-file .env -f examples/server-compose/docker-compose.yml exec koed-server \
  pnpm api-token:create --owner-email local@koed.ai --name "Codex"
```

Do not point normal AI Client integrations directly at this remote/server API.
Each User's AI Client MCP adapter and Supported Capture Hook should normally use
that User's local `koed-server`. That server supervises an authenticated Local
AI Runtime, which hosts Codex, Claude, and Pi Transcript Watchers. External runtime mode does not
run either user-local component. Transcript roots default to
`CODEX_HOME/sessions` and may be replaced with explicit local roots. Each
Supported Capture Hook wake completes one bounded, paginated discovery sweep,
with concurrent wakes coalesced into a refreshed sweep. A Stop boundary also
schedules one trailing catch-up so records that Codex flushes after the Hook
returns do not wait for the next incoming message. While a canonical cursor has
an open turn, the watcher also rechecks only that transcript with bounded
backoff until it consumes terminal evidence. A one-second catch-up tick checks
only a bounded rotation of known sources and the newest discovery page,
covering missed Hook and filesystem delivery without continuous full scans.
Claude capture uses content-free lifecycle signals and reads provider-native
Conversation Sources from configured Claude home. Pi capture uses content-free
extension wake signals plus periodic discovery of persistent Pi JSONL sessions;
see [Pi integration](pi-integration.md). The
local `koed-server` then registers this server as an upstream and routes
approved Team Workspace recall, Share
Grant, sync/offload, or remote capture-bearing operations through local-edge
policy. This keeps watcher capture in Personal Memory and avoids exposing
upstream/cloud/device credentials to MCP, Transcript Watcher, or Capture Hook
processes.

### Bundled-local native runtime

Set `KOED_DEPENDENCY_MODE=bundled-local` to let `koed-server start` launch
native Koed-owned Postgres/pgvector and Embedding Service runtimes under
`KOED_HOME` and default the API/Worker queue backend to `local`. Redis is not
required for queues in this mode unless `WORK_QUEUE_BACKEND=bullmq` is
explicitly set; with BullMQ, Redis is Operator-managed external infrastructure.
The Postgres-backed local queue permits one Worker runtime at a time through a
session-scoped database advisory lock. If that process exits unexpectedly, its
database session releases the lock; the replacement Worker then immediately
requeues interrupted jobs without consuming an attempt or waiting for their
ordinary processing lease.

Desktop keeps its generated Personal API Token across normal restarts. Startup
validates the persisted token against the active local database and only
replaces it when the token is missing, revoked, expired, or no longer present
after a database reset.

Desktop records completion of its first-run guide under the active `KOED_HOME`
rather than browser storage, so the setup state is durable and isolated per
local installation.

Bundled-local mode is native-only. Native Postgres binaries should be available under `KOED_HOME/runtime/postgres/bin` or `KOED_POSTGRES_BIN_DIR`, including `psql`, `pg_dump`, and `pg_restore` for backup/restore operations, and the Embedding Service needs `embedding-service/dist/index.js`, `KOED_HOME/runtime/llama.cpp/llama-server`, and model assets. Packaged native runtime assets no longer include Python standalone files or `embedding-service/.venv/bin/python`; `KOED_EMBEDDING_PYTHON_BIN` is not used by the supported bundled-local path. The README Quickstart builds the workspace, runs runtime install, and installs the embedding model as `pnpm local:setup`. Packaged Desktop also checks packaged app resources after `KOED_HOME/runtime`. Source-checkout `vendor` and `apps/embedding-service` paths remain development fallbacks only; packaged mode rejects those fallbacks unless `KOED_ALLOW_PACKAGED_SOURCE_FALLBACK=1` is set for developer diagnostics. `KOED_BUNDLED_POSTGRES_MODE` and `KOED_BUNDLED_EMBEDDING_MODE` are deprecated and ignored. Missing native resources fail with setup guidance instead of falling back to Docker Compose. Docker Compose is available only as an Operator-selected external dependency starter.

On macOS, Linux, and WSL, Homebrew is one selected provisioning path for the native runtime assets under `KOED_HOME`:

```bash
pnpm runtime:status
pnpm runtime:install
```

`runtime status` is diagnostic-only and never installs packages. `runtime install` may run `brew install postgresql@17 pgvector llama.cpp` when packages are missing, then links selected binaries under `KOED_HOME/runtime` and records install metadata under `KOED_HOME/cache`. The default embedding model is installed separately with a pinned URL and SHA-256 checksum:

```bash
pnpm models:install:embedding
```

Set `KOED_EMBEDDING_MODEL_URL` and `KOED_EMBEDDING_MODEL_SHA256` only when installing a custom embedding model artifact. Use `--kind reranker` with `KOED_RERANKER_MODEL_URL` and `KOED_RERANKER_MODEL_SHA256` when enabling reranking.

### WSL development

Run Koed inside WSL as Linux tooling. Keep `KOED_HOME` on Linux filesystem paths such as `/home/<user>/.koed`; do not point bundled-local runtime state at Windows paths. Use the same `pnpm install`, `pnpm build`, `runtime status/install`, `models install`, `start`, `status`, and `doctor` commands from WSL.

Windows host clients can usually reach Koed through WSL localhost forwarding at `http://localhost:<API_HOST_PORT>`. If localhost forwarding is not available, resolve the WSL IP from inside WSL and use that address instead:

```bash
wsl.exe hostname -I
```

Then use `http://<WSL_IP>:<port>` for the API. Native Windows packaged app support is not shipped in this build; use WSL for Windows development.

### Packaged Desktop first-run

Packaged Koed Desktop starts its managed local-personal `koed-server` with `runtimeMode=local-personal`, `dependencyMode=bundled-local`, and `WORK_QUEUE_BACKEND=local`. First run resolves `KOED_HOME`, persists the public service and private llama-server child ports in `KOED_HOME/config/local-ports.json`, and uses the same inspect-before-change setup workflow as source Desktop. Allocating the child ports per Koed home allows independent local installations to run concurrently without sharing model processes. Packaged runtime assets are preferred first; Homebrew-backed runtime install is only used when that provisioning path is selected on macOS, Linux, or WSL. Native Windows packaged app support is not part of this build, so Windows development should use WSL.

`desktop:package` and `desktop:package:smoke:mac` build unsigned local smoke artifacts. `desktop:package:internal:mac` prepares unsigned macOS `dmg` and `zip` outputs for internal testing, including packaged native runtime assets when `KOED_NATIVE_RUNTIME_SOURCE_DIR` is set. New GitHub Releases upload these unsigned Desktop assets and checksums after packaged-native smoke passes. Signed/notarized release artifacts still require future Developer ID credential setup.

Run the bundled-local smoke workflow to verify the native control-plane path
with an isolated temporary `KOED_HOME` and temporary host ports:

```bash
pnpm smoke:bundled-local -- --full --install-runtime --json
```

`--install-runtime` explicitly runs the Homebrew-backed runtime install for the
temporary `KOED_HOME` before native resource checks. The smoke workflow skips
explicit model installation unless `KOED_EMBEDDING_MODEL_URL` and
`KOED_EMBEDDING_MODEL_SHA256` are configured. `--full` adds API Token creation,
Capture Hook-like personal ingestion, Projection, local queue/embedding work,
Memory Answer evidence retrieval with a unique marker, API readiness,
and cleanup through `koed-server stop --json`. Missing native binaries or model
assets fail clearly instead of falling back to Docker.

Packaged Desktop smoke now exercises the packaged Electron bundle with a temporary `KOED_HOME`, unsets `KOED_REPO_ROOT`, and verifies daemon start/status/reconnect/stop without checkout fallbacks. For CI or diagnostics when native assets are absent, run:

```bash
pnpm desktop:package:smoke:mac -- --missing-assets --json
```

When packaged native assets are staged, omit `--missing-assets` to let smoke install packaged runtime assets, start the daemon, and reach a healthy local stack. See `docs/desktop-internal-artifacts.md` for unsigned GitHub Release DMG/ZIP download, install/open, Gatekeeper-warning, runtime status/doctor, and cleanup instructions.

If dependency ports conflict with another local app, start the external dependency stack with alternate host ports and pass matching explicit URLs to `koed-server`:

```bash
REDIS_HOST_PORT=16380 EMBEDDING_SERVICE_HOST_PORT=3801 docker compose --env-file .env -f examples/docker-compose/docker-compose.yml up -d --build
KOED_DEPENDENCY_MODE=external API_HOST_PORT=3300 REDIS_URL=redis://localhost:16380 EMBEDDING_SERVICE_URL=http://localhost:3801 node packages/koed-server/dist/cli.js start
```

### Koed Desktop

Koed Desktop is the Electron control surface for the same local control plane.
It wraps `koed-server`, shows service status, and can start the supervisor,
run Codex setup, run doctor, and explicitly trigger Homebrew-backed runtime
install with Operator confirmation. Packaged Koed
Desktop starts its managed local personal server with bundled-local native
runtime defaults unless the Operator explicitly overrides runtime/dependency
mode; source-checkout Desktop keeps the bare developer default and uses explicit
external dependency configuration.

```bash
pnpm --filter @koed/desktop start
```

For local packaged-native smoke with Homebrew/Linuxbrew-provided assets, stage the native runtime first and pass it into packaging:

```bash
pnpm native-runtime:stage:homebrew -- --out /tmp/koed-native-runtime --force
KOED_NATIVE_RUNTIME_SOURCE_DIR=/tmp/koed-native-runtime pnpm --filter @koed/desktop package:mac
```

The Homebrew staging helper copies Homebrew/Linuxbrew Postgres/pgvector and llama.cpp assets only. It no longer requires or packages an Embedding Service Python virtualenv, and it does not create release-quality redistributable native runtime assets.

For renderer development only:

```bash
pnpm --filter @koed/desktop dev
```

## LCM Smoke Test

`pnpm smoke:lcm` expects a disposable Docker Compose stack using the small LCM
smoke profile. The profile lowers the LCM thresholds and raises only the local
write limit needed for the test; it does not change product defaults.

```bash
docker compose --env-file .env -f examples/docker-compose/docker-compose.yml up -d --build postgres redis embedding-service
# In another shell, run koed-server start with scripts/lcm-smoke.env loaded before pnpm smoke:lcm
pnpm api-token:create --owner-email smoke@example.local --name lcm-smoke
MEMORY_API_TOKEN=<token> pnpm smoke:lcm
```

## Production Notes

Operate production and private VPS installs as `koed-server` plus dependencies.
Keep Postgres, Redis, and the Embedding Service private. Expose only the
browser/API-facing `koed-server` surface through your reverse proxy. Set strong
`API_DATA_ENCRYPTION_KEY`, `API_TOKEN_PEPPER`, `EMBEDDING_SERVICE_TOKEN`,
database password, and Redis password. Use TLS at the reverse proxy if the
server is reachable beyond localhost.
For hosted/private database role hardening and the RLS decision, see
[hosted-database-roles.md](hosted-database-roles.md).

Local personal deployments may keep operational Memory rows in Postgres unless
app-layer encryption is configured. Private VPS, Team Self-Hosted, and
Koed-managed cloud deployments should configure envelope encryption for
human-readable Memory and evidence payloads; queryable vectors still remain
sensitive trusted-boundary data. Protect the database and backups with private
networking, least-privilege credentials, encrypted storage, and restricted
administrator access.

Only `/health` and `/ready` are intended for unauthenticated infrastructure probes. They return coarse status and should not be used as operator diagnostics. `/v1/capabilities` is also unauthenticated, but it is a client discovery contract rather than a health check: clients can use it to detect the positive capabilities registered by the current backend, and should treat missing capabilities as unavailable. `status --json` and `doctor --json` use readiness gates for Postgres reachability/version, migrations, pgvector, work queue backend, Embedding Service model/dimensions, and registered upstream capability-cache state before reporting healthy; doctor output gives repair actions such as running migrations, enabling pgvector, fixing dependency URLs, refreshing upstream capabilities, or correcting model/runtime mismatch. Registered upstream backends are local edge metadata only: capability caches and route-policy state live under `KOED_HOME/config/upstream-backends.json`, while reusable upstream/device credentials must stay out of ordinary config. Detailed status endpoints such as `/health/details`, `/self-host/diagnostics`, and the authenticated view of `/self-host/status` should remain behind normal API authentication. Koed Desktop packaging/signing remains tracked separately from this local runtime path.
