# Two-User VPS Dogfood Runbook

Use this runbook to validate two isolated Koed Desktop Users against one
disposable Private VPS or Team Self-Hosted backend. It complements
[Team SaaS Launch Validation](team-saas-launch-validation.md) and
[Collaboration Launch Validation](collaboration-launch-validation.md); it does
not replace the fixture, automated, backup, or release gates in those
documents.

Do not use these reset steps against production data. Use a dedicated Team,
Workspace, local profiles, and database that can all be discarded.

## Test Topology

- One remote `koed-server` deployment with Postgres, its work queue backend,
  and the Embedding Service.
- One public HTTPS Explorer/API origin for the remote deployment.
- Two different remote Users, each authenticated in a separate browser profile.
- Two isolated local `KOED_HOME` directories and Electron user-data
  directories.
- One stable environment file per local profile.
- Distinct local API, Explorer, Postgres, and Embedding Service ports.
- One remote Team and one Workspace shared by both Users.

Never share these between the two local profiles:

- `KOED_HOME`;
- Electron `--user-data-dir`;
- Personal database;
- local API or Explorer credential;
- local encryption keys;
- upstream device credential;
- realtime cursor or cached Team state.

The two profiles may share the repository checkout and downloaded model
artifact only when the model file is treated as read-only.

## Required Inputs

Set shell variables without placing secrets in the repository:

```bash
export KOED_REPO_ROOT="$PWD"
export KOED_REMOTE_URL="https://team.example.test"
export KOED_A_HOME="$HOME/.koed-dogfood-alice"
export KOED_B_HOME="$HOME/.koed-dogfood-bob"
export KOED_A_ENV="$KOED_A_HOME/local.env"
export KOED_B_ENV="$KOED_B_HOME/local.env"
export KOED_A_ELECTRON_HOME="$KOED_A_HOME/electron-user-data"
export KOED_B_ELECTRON_HOME="$KOED_B_HOME/electron-user-data"
```

Each profile environment must contain its own stable application-layer
encryption key configuration, API token pepper, database password, and local
ports. Do not launch either profile through the repository `.env`. Every
command in this runbook passes both `KOED_HOME` and `KOED_ENV_PATH`
deliberately.

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

Repeat for Bob. If remote revocation cannot be confirmed, revoke the credential
through the authenticated backend before deleting local state. A failed
disconnect is not permission to strand an active credential.

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

2. Launch each Desktop with explicit profile state:

   ```bash
   KOED_HOME="$KOED_A_HOME" \
   KOED_ENV_PATH="$KOED_A_ENV" \
   KOED_REPO_ROOT="$KOED_REPO_ROOT" \
   KOED_DEPENDENCY_MODE=bundled-local \
   KOED_AUTO_PORTS=1 \
     pnpm --filter @koed/desktop exec electron . \
       --user-data-dir="$KOED_A_ELECTRON_HOME"
   ```

   Repeat with the `B` variables in a separate terminal.

3. Wait for each local `/ready` endpoint. Confirm Postgres, migrations,
   pgvector, Embedding Service model, and work queue are all `ok`.

4. Confirm each Desktop can open Personal Memory before connecting or
   reconnecting Team.

5. For a fresh local database, use Desktop's Codex repair action. Restart Codex
   and trust the updated hooks if prompted. Only one machine-wide Codex profile
   can target one local Koed profile at a time; synthetic second-Desktop testing
   does not make Bob's profile the machine-wide Capture target.

6. Confirm each Desktop reports the expected remote backend identity and
   authenticated User. A healthy capability document without a scoped device
   credential is not an enrolled local edge.

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

1. **Personal Capture**
   - Capture a new Alice User prompt, tool call/result, and Agent completion.
   - Confirm one canonical transcript item per source item.
   - Confirm the Agent turn seals according to item/token boundaries.
   - Wait for the resulting Memory Event embedding.
   - Confirm Bob cannot see the Personal source.

2. **Share And Synchronize**
   - Alice selects the new Captured Session and Workspace.
   - Alice selects the intended representation level: Memory Events, LCM
     leaves, or LCM rollups.
   - Confirm the preview is bounded and requires explicit consent.
   - Confirm the source relationship and outbox advance to ready without a
     failed row or endless retry.
   - Confirm the remote representation is encrypted at rest.

3. **Bob Shared Memory**
   - Confirm Bob's Shared Memory list updates without manual refresh.
   - Open the shared timeline and verify its fidelity matches the selected
     representation level.
   - Confirm Bob's Personal Memory remains empty of Alice's source.
   - Run Team recall for the unique marker and verify the result cites the
     authorized shared representation.

4. **Realtime Collaboration**
   - Alice sends a Workspace channel message and Bob receives it without
     refresh.
   - Bob replies and Alice receives it without refresh.
   - Retry one message with the same idempotency key and observe one message.
   - Open the shared AI conversation and its companion discussion in both
     Desktops; verify updates arrive without polling.

5. **Restart And Catch-Up**
   - Stop both Desktops cleanly.
   - Relaunch with the same profile variables.
   - Confirm Personal opens immediately and Team reconnects independently.
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
local_ready:
  alice: "<pass/fail>"
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
