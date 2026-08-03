# Two-User VPS Dogfood Runbook

Use this runbook to validate two isolated Koed Desktop Users in both Personal
Device Sync (PDS) local-only and remote-backend topologies. The remote backend
may be a disposable Private VPS or Team Self-Hosted deployment. It complements
[Team SaaS Launch Validation](team-saas-launch-validation.md) and
[Collaboration Launch Validation](collaboration-launch-validation.md); it does
not replace the fixture, automated, backup, or release gates in those
documents.

Do not use these reset steps against production data. Use a dedicated Team,
Workspace, local profiles, and database that can all be discarded.

## Test Topologies

Run both topologies from fully fresh local profiles. They establish different
properties and neither is a substitute for the other.

| Topology                        | Authority and transport                                                                                                                                                                                                                                          | Required proof                                                                                                                                                                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local-only Personal Device Sync | Device A's fixed V1 Authority/Relay host carries encrypted immutable closed Captured Session packages and compatible portable artifact packages between two devices in one Personal Device Group. Neither device has a configured remote `koed-server` upstream. | A closed source session materializes once on the second device; compatible Memory Event, embedding, and LCM artifacts are reused without copying device-local execution state, with local derivation as the compatibility fallback. |
| Remote Personal/Team backend    | Each local edge connects and enrolls with one remote `koed-server`; the backend provides the Personal/Team authority and source-replication target.                                                                                                              | Personal source replication, Team authorization, Share Grant visibility, and realtime collaboration work with the remote service unavailable only for its remote-dependent features.                                                |

PDS V1 deliberately transfers only eligible future **closed** Captured Sessions.
It does not transfer open sessions, mutable Personal notes/channels, renderer
state, indexes, queue jobs, or runtime credentials. It may transfer separately
signed compatible Memory Event, embedding, and LCM node artifacts bound to an
accepted closed source package. Do not represent an absent note/channel on the
other device as a PDS transport failure: that requires the separate
mutable-collaboration replication design.

### Remote Backend Topology

- One remote `koed-server` deployment with Postgres, its work queue backend,
  and the Embedding Service.
- One public HTTPS Explorer/API origin for the remote deployment.
- Two isolated local devices for Alice's one remote Personal identity, each
  with its own `KOED_HOME`, `CODEX_HOME`, and Electron user-data directory.
- One separate Bob profile for Team/Workspace authorization and realtime
  collaboration. A full Personal-plus-Team run therefore uses three local
  profiles; a two-profile run proves only one of those concerns at a time.
- One stable environment file per local profile.
- Distinct local API, Explorer, Postgres, and Embedding Service ports.
- One remote Team and one Workspace shared by both Users.

Never share these between the two local profiles:

- `KOED_HOME`;
- `CODEX_HOME` or `CODEX_CONFIG_PATH`;
- Electron `--user-data-dir`;
- Personal database;
- local API or Explorer credential;
- local encryption keys;
- upstream device credential;
- realtime cursor or cached Team state.

The two profiles may share the repository checkout and downloaded model
artifact only when the model file is treated as read-only.

### Local-only PDS Topology

- Two isolated local `KOED_HOME` directories, Personal databases, encryption
  keys, `CODEX_HOME` directories, and Electron user-data directories.
- Two active devices in the same Personal Device Group, each with its own
  device key material and no configured remote upstream.
- A relay configured only for PDS encrypted package delivery and acknowledgements.
- Distinct local API, Explorer, Postgres, Embedding Service, and PDS gateway
  ports.

Use the same isolation rules as the remote topology. A PDS device must never
reuse another device's `KOED_HOME`, device credential, browser profile, local
database, or encryption key material.

Two real devices may each use the default PDS gateway port `3310` because they
have different network addresses. When simulating both devices on one host,
set a different `KOED_PDS_LAN_PORT` in each profile, such as `3310` for Device
A and `3311` for Device B. This is test-host port isolation, not an alternate
pairing protocol or authentication control.

## Required Inputs

Prepare two disposable profile roots with:

```bash
pnpm multi-device:prepare --reset
```

The command writes a redacted manifest under the reported temporary root. It
creates separate Koed, Codex, and Electron homes and separate generated env
files. Each generated bundled-local env selects the local queue backend and an
explicit profile-local Codex config path, so it does not depend on Redis or the
Operator's default Codex profile. It does not start services, enroll devices, or
store credentials in the manifest. Use those paths for the launch commands
below. The later `multi-device:validate` gate independently rejects shared or
default Codex profiles.

Set shell variables without placing secrets in the repository:

```bash
export KOED_REPO_ROOT="$PWD"
export KOED_REMOTE_URL="https://team.example.test"
export KOED_TEST_MODELS_DIR="$HOME/.koed/models"
export KOED_A_HOME="$HOME/.koed-dogfood-alice"
export KOED_B_HOME="$HOME/.koed-dogfood-bob"
export KOED_A_CODEX_HOME="$HOME/.codex-dogfood-alice"
export KOED_B_CODEX_HOME="$HOME/.codex-dogfood-bob"
export KOED_A_CODEX_CONFIG="$KOED_A_CODEX_HOME/config.toml"
export KOED_B_CODEX_CONFIG="$KOED_B_CODEX_HOME/config.toml"
export KOED_A_ENV="$KOED_A_HOME/local.env"
export KOED_B_ENV="$KOED_B_HOME/local.env"
export KOED_A_ELECTRON_HOME="$KOED_A_HOME/electron-user-data"
export KOED_B_ELECTRON_HOME="$KOED_B_HOME/electron-user-data"
export KOED_BOB_HOME="$HOME/.koed-dogfood-bob"
export KOED_BOB_ENV="$KOED_BOB_HOME/local.env"
export KOED_BOB_ELECTRON_HOME="$KOED_BOB_HOME/electron-user-data"
```

Each profile environment must contain its own stable application-layer
encryption key configuration, API token pepper, database password, and local
ports. Each profile must also use a distinct `CODEX_HOME`; otherwise two local
Koed instances can observe the same source transcript directory. Do not launch
either profile through the repository `.env`. Every command in this runbook
passes `KOED_HOME`, `KOED_ENV_PATH`, `CODEX_HOME`, and `CODEX_CONFIG_PATH`
deliberately. Synthetic profiles on one machine may share the same verified,
read-only `KOED_MODELS_DIR` to avoid duplicate model downloads, but the
supervisor and Desktop processes must receive the same value.

Pass `KOED_AUTO_PORTS=1` when first starting each local profile or Desktop.
The supervisor records automatic-port mode in its runtime state, so later
status, doctor, setup, repair, and restart commands inherit the profile's
supervisor-owned local API credential and persisted port lease instead of an
unrelated checkout credential or default port.

Before starting, record only:

- commit SHA and deployment release;
- remote deployment profile and capability schema version;
- non-secret local port assignments;
- start time and test-case result.

Do not record cookies, API Tokens, device credentials, encryption keys,
connection strings, raw Memory, or transcript content.

## Reset Modes

### Fully Fresh Remote Backend

Use this before installation, schema, encryption, authorization, or first-run
validation. Do not describe a run as fresh when it reuses application rows from
an earlier deployment.

1. Stop the disposable remote deployment.
2. Remove its Koed Postgres data volume and any disposable queue or object
   storage state through the deployment's documented teardown operation.
3. Preserve only infrastructure inputs that belong outside Koed application
   state, such as DNS, TLS, WorkOS configuration, and the deployment secret
   source.
4. Start the deployment through its normal installation path and allow Koed to
   create the database and run migrations. Do not manually create, truncate, or
   patch application tables.
5. Confirm `/ready`, the public capability document, the authenticated
   capability document, database migrations, pgvector, queue health, and the
   Embedding Service before creating test Users or Teams.
6. Confirm the fresh Koed database contains no prior Team, Workspace, Share
   Grant, Cross-Identity Sync, device enrollment, collaboration, Memory, or
   audit rows.

WorkOS identities may continue to exist in the configured WorkOS environment;
their Koed User mappings and Team authorization must be recreated in the fresh
Koed database. Rotate disposable deployment encryption material only when the
old encrypted database and backups have also been discarded. Never reuse a
database after changing its application-layer encryption key lineage.

Use the deterministic fixture reset instead when the test explicitly requires
stable fixture identities. A fixture reset and a fully fresh deployment prove
different behavior and must be recorded separately.

### Fully Fresh User

Use this for installation and enrollment testing. While the old profile can
still authenticate, disconnect every registered Team Backend so Koed revokes
the remote device credentials before clearing local state:

```bash
KOED_HOME="$KOED_A_HOME" \
KOED_ENV_PATH="$KOED_A_ENV" \
KOED_REPO_ROOT="$KOED_REPO_ROOT" \
  node packages/koed-server/dist/cli.js upstream disconnect \
    --id "<alice-backend-id>" --json
```

Repeat for Alice's second device and Bob. If remote revocation cannot be
confirmed, revoke the credential through the authenticated backend before
deleting local state. A failed disconnect is not permission to strand an active
credential.

Next stop the profile, verify its Postgres process has exited, remove the entire
disposable `KOED_HOME` and Electron user-data directory, then recreate the
profile environment and install the bundled-local runtime and model through the
documented fresh-clone flow.

This intentionally removes Personal Memory, local encryption keys, the local
Personal principal, all local credentials, remote enrollment, cached Team
state, and browser state. Complete browser-mediated device enrollment again.
A device credential is bound to the original local Personal principal and must
not survive a database reset that creates a different principal.

There is no supported “delete the local database but preserve enrollment”
shortcut. To preserve enrollment, preserve the database identity and use the
deterministic fixture reset for fixture-owned content, or delete test content
through supported product operations. Do not manually truncate application
tables.

Mixing an old database with a different profile environment is invalid. An
`InvalidEncryptedPayloadEnvelopeError` or key-id mismatch is a failed reset,
not a row to skip or repair during this dogfood test.

## Start Order

1. Confirm the remote backend is ready:

   ```bash
   curl -fsS "$KOED_REMOTE_URL/ready"
   curl -fsS "$KOED_REMOTE_URL/v1/capabilities"
   ```

2. Start profiles serially. Automatic port allocation uses a machine-wide,
   locked lease registry, but serial startup is still the required dogfood
   procedure because it produces an unambiguous health boundary for each
   profile. Start device A and wait until its local `/ready` endpoint and
   bundled-local Postgres and Embedding Service are healthy before starting
   device B. Repeat that readiness gate before starting Bob.

   If a disposable profile has never reached readiness and persisted a
   stale or conflicting lease after an interrupted start, stop that profile,
   remove only its
   `$KOED_HOME/config/local-ports.json`, and restart it after the earlier
   profile is healthy. Never delete a port lease from a running profile, and do
   not use this reset for an established User profile.

3. Launch each Desktop with explicit profile state:

   ```bash
   KOED_HOME="$KOED_A_HOME" \
   KOED_ENV_PATH="$KOED_A_ENV" \
   CODEX_HOME="$KOED_A_CODEX_HOME" \
   CODEX_CONFIG_PATH="$KOED_A_CODEX_CONFIG" \
   KOED_REPO_ROOT="$KOED_REPO_ROOT" \
   KOED_MODELS_DIR="$KOED_TEST_MODELS_DIR" \
   KOED_DEPENDENCY_MODE=bundled-local \
   KOED_AUTO_PORTS=1 \
     pnpm --filter @koed/desktop exec electron . \
       --user-data-dir="$KOED_A_ELECTRON_HOME" \
       --remote-debugging-port=9224
   ```

   Repeat with the `B` variables for Alice's second device and
   `KOED_PDS_LAN_PORT=3311` and `--remote-debugging-port=9225` when both
   simulated devices run on the same host. Use a third isolated port for Bob.
   These loopback CDP endpoints are test-only and must not be exposed on a
   network.

4. Wait for each local `/ready` endpoint. Confirm Postgres, migrations,
   pgvector, Embedding Service model, and work queue are all `ok`.

   Drive fresh Desktop setup through one path exactly once. Do not invoke setup
   directly and then run the Electron setup helper against the same
   still-rendered page; that attempts a second setup instead of testing restart
   recovery. After setup reports complete, finish the trust guide or reload the
   renderer before invoking another setup action.

5. Confirm each Desktop can open Personal Memory before connecting or
   reconnecting Team.

6. For a fresh local database, use Desktop's Codex repair action. Restart Codex
   and trust the updated hooks if prompted. Only one machine-wide Codex profile
   can target one local Koed profile at a time; synthetic second-Desktop testing
   does not make Bob's profile the machine-wide Capture target.

7. Confirm Alice's two Desktops report the same expected remote User and Bob's
   Desktop reports Bob. A healthy capability document without a scoped device
   credential is not an enrolled local edge.

## Automated Multi-Device Electron Gate

After both Alice devices are ready, enrolled, and running with their isolated
CDP ports, run:

```bash
pnpm multi-device:validate \
  --backend-id "<alice-backend-id>" \
  --device-a-cdp-port 9224 \
  --device-b-cdp-port 9225 \
  --report /tmp/koed-multi-device-report.json
```

This drives the actual Electron renderer bridges and verifies:

- each device uses a distinct synthetic Codex profile and neither device uses
  the Operator's default `~/.codex/config.toml`;
- both devices use the same live remote Personal authority;
- Notes-to-self messages move from A to B and B to A through unsolicited
  realtime updates;
- a Personal channel created on A appears on B;
- B can post to that channel and A receives the update;
- B reloads its renderer and catches up a message sent during reconnection;
- no renderer exception or non-canceled network failure occurred during the
  run.

The runner observes the renderer's existing subscription and does not create a
polling loop or acknowledge deliveries on the renderer's behalf. It writes no
credentials or message bodies to the report beyond unique synthetic markers.

The same gate can run as part of the broader launch validator:

```bash
pnpm team-launch:validate \
  --with-multi-device \
  --device-a-cdp-port 9224 \
  --device-b-cdp-port 9225 \
  --multi-device-backend-id "<alice-backend-id>"
```

Generated profile files are dotenv inputs, not shell scripts. When a test
process must load one directly, use Node's `--env-file=<path>` support or the
Koed config loader. Do not `source` the file in a shell.

Isolated Desktop profiles pass their assigned API, Explorer, Postgres, Redis,
embedding, and debugging ports to supervised children at launch. A profile's
`local.env` remains a default configuration input and is not authoritative for
those live overrides. Use Desktop status plus
`KOED_HOME/config/local-ports.json`, or the multi-device runner, to resolve each
device's actual endpoint. Before direct database assertions, prove that Device
A and Device B target distinct Postgres ports; querying the default URL twice
is invalid evidence.

## Local-only PDS End-To-End Flow

Run this before the remote Team flow. Keep both devices disconnected from any
hosted Personal Memory or Team backend for the whole case. PDS V1 is
relay-required, so this topology still uses the configured opaque PDS
Authority/Relay service; that service is not a Personal Memory authority, does
not project or embed source data, and does not own aggregate Recall. The
Authority-hosting installation is nevertheless a fixed operational hub in V1:
its outage pauses enrollment, governance, and package transfer.

1. Run the deterministic and real API-first gates before Electron:
   `pnpm pds-fixture:validate` with its PostgreSQL stage enabled, then
   `pnpm pds-pairing:e2e` against two disposable local-personal APIs and two
   distinct databases using the joining-control variables documented in
   [Running Koed](running-koed.md#same-network-desktop-pairing). Do not continue
   if either skips required storage coverage, uses the same API origin/database,
   or fails.
2. Create or recover one Personal Device Group through the supported device
   enrollment flow. Keep Device A as the local Authority-hosting installation.
   From Device A's **Devices** modal, issue the QR/link; on Device B, use
   **Join with link**; compare the short code; approve on A.
   Confirm both devices become active group members and each holds only its own
   local device secrets. Confirm Device B does not offer an invitation action
   that would require Device A's Authority key. Device A is the fixed
   operational Authority/Relay hub in V1, while both devices remain symmetric
   data-plane replicas with local capture and Recall.
   Progress must use the held pairing exchange without periodic refresh or
   arbitrary sleep-based timing.
3. On device A, capture a unique User prompt, tool call/result, and completed
   Agent turn. Close the Captured Session through the supported source lifecycle.
4. Confirm device A emits one immutable source package for that closed Session.
   The source package contains source observations only. Portable Memory Event,
   embedding, and LCM node artifacts use separate signed and encrypted packages;
   no package exposes plaintext relay metadata.
5. Confirm device B validates and materializes the package once. In device B's
   database, verify original source actor/type/order and one local terminal
   closure marker; verify no duplicate raw source row exists. Confirm its inbox
   is not completed before the signed relay ACK succeeds.
6. Confirm device B transactionally imports compatible Memory Events and
   embeddings without duplicate local work. For one deliberately incompatible
   embedding contract, confirm source still materializes and local derivation
   remains pending instead of coercing the vector. Confirm rendering occurs
   without manual refresh.
7. Restart device B. Confirm the package is not replayed into duplicate source
   rows or Memory Events, and local recall can retrieve the unique marker once
   embedding completes. Confirm device A's durable outbox reaches `acked` only
   after device B's ACK, and that device A never receives its own transport as
   an inbox delivery.
8. Confirm a Personal note, Personal channel, and edited/open Session do **not**
   appear on device B. Confirm local indexes, queue rows, physical leases, and
   credentials were not transferred. Record them as excluded PDS V1 data
   classes, not as a failed retry.

Reject the run if PDS changes source actor/type/order, accepts an artifact
without exact source/contract/claim validation, copies device-local execution
state, creates duplicate source or semantic rows, processes an unverified/open
source, or blocks local capture and Recall while the relay is unavailable.

## Enrollment And Team Setup

For each User independently:

1. Paste the remote HTTPS URL into the Team connection surface.
2. Validate remote capabilities.
3. Complete browser login in that User's browser profile.
4. Approve the exact pending device enrollment.
5. Confirm Desktop stores a credential reference, not credential plaintext.
6. Confirm reconnect succeeds without another login.

As Alice:

1. Create the disposable Team and Workspace, or verify the pre-created test
   scope.
2. Create a single-use invite for Bob.

As Bob:

1. Accept the invite under Bob's authenticated identity.
2. Confirm the expected Team membership and Workspace Access.

Reject the run if either Desktop resolves to the other User, if a browser
session can approve an enrollment for a different pending device, or if a local
API Token can authorize Team operations.

## Positive End-To-End Flow

Use unique, harmless markers for this run.

1. **Remote Personal Source Replication**
   - On Alice device A, capture a new User prompt, tool call/result, and Agent
     completion.
   - Confirm one canonical transcript item per source item.
   - Confirm the Agent turn seals according to item/token boundaries.
   - Confirm Alice device B receives the source material once and imports
     compatible derived artifacts under their exact source identities.
   - Confirm incompatible or unavailable artifacts fall back to local work and
     both Personal views render the closed source without a manual refresh.

2. **Personal Isolation**
   - Confirm Bob cannot see the Personal source.

3. **Share And Synchronize**
   - Alice selects the new Captured Session and Workspace.
   - Alice selects the intended representation level: Memory Events, LCM
     leaves, or LCM rollups.
   - Confirm the preview is bounded and requires explicit consent.
   - Confirm the source relationship and outbox advance to ready without a
     failed row or endless retry.
   - Confirm the remote representation is encrypted at rest.

4. **Bob Shared Memory**
   - Confirm Bob's Shared Memory list updates without manual refresh.
   - Open the shared timeline and verify its fidelity matches the selected
     representation level.
   - Confirm Bob's Personal Memory remains empty of Alice's source.
   - Run Team recall for the unique marker and verify the result cites the
     authorized shared representation.

5. **Realtime Collaboration**
   - Alice sends a Workspace channel message and Bob receives it without
     refresh.
   - Bob replies and Alice receives it without refresh.
   - Retry one message with the same idempotency key and observe one message.
   - Open the shared AI conversation and its companion discussion in both
     Desktops; verify updates arrive without polling.

6. **Restart And Catch-Up**
   - Stop all three Desktops cleanly.
   - Relaunch with the same profile variables.
   - Confirm Alice Personal opens immediately on both devices and Team
     reconnects independently.
   - Confirm no duplicate messages, Memory Events, or shared representations.

Repeat the Share And Synchronize and Bob Shared Memory cases once for each
supported representation level. Do not infer leaf or rollup behavior from a
Memory Event-only pass.

## Negative And Penetration Checks

Prove each boundary independently:

- Alice's Personal API Token cannot read Team Workspace Memory.
- Bob cannot read Alice's unshared Personal source.
- A User outside the Team cannot enumerate the Team, Workspace, channel,
  Shared Session, representation, graph, or evidence.
- A Team member without Workspace Access cannot read that Workspace.
- A read-only member cannot write chat, grant sharing, or perform high-risk
  actions.
- A revoked Share Grant disappears from future Shared Memory reads and
  realtime state.
- A revoked/rotated device credential cannot reconnect or replay.
- A stale, reused, or altered browser Action Grant fails.
- A cursor from another User, Team, Workspace, backend, client instance, or
  subscription fails closed.
- Renderer-supplied backend URLs with embedded credentials, non-HTTPS remote
  schemes, loopback confusion, or disallowed redirects are rejected.
- Logs, diagnostics, queue payloads, audit metadata, and API errors contain no
  Memory plaintext, cookies, bearer/device credentials, or encryption material.
- Taking the Team backend offline leaves Personal available; recovery requires
  no application restart and introduces no duplicate realtime events.

Run the staged remote validator and relevant automated suites as supporting
evidence. Manual UI success does not replace those gates.

## Completion Record

Record pass/fail only:

```yaml
commit: "<sha>"
remote_release: "<version>"
remote_profile: "<profile>"
remote_backend_fresh: true
local_profiles_fresh: true
stable_profile_envs_used: true
local_only_pds:
  closed_session_materialization: "<pass/fail>"
  local_projection_and_embedding: "<pass/fail>"
  replay_idempotency: "<pass/fail>"
  excluded_mutable_data_remained_local: "<pass/fail>"
local_ready:
  alice_device_a: "<pass/fail>"
  alice_device_b: "<pass/fail>"
  bob: "<pass/fail>"
enrollment:
  alice: "<pass/fail>"
  bob: "<pass/fail>"
personal_capture: "<pass/fail>"
memory_event_share: "<pass/fail>"
leaf_share: "<pass/fail>"
rollup_share: "<pass/fail>"
team_recall: "<pass/fail>"
realtime: "<pass/fail>"
restart_catch_up: "<pass/fail>"
negative_authorization: "<pass/fail>"
redaction: "<pass/fail>"
residual_issues: []
```

Any mixed encryption lineage, failed sync state, authorization leak, API Token
Team access, stale shared content after revocation, duplicate replay, or
Personal outage during a Team failure fails the run.
