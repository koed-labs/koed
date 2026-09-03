# Configuration

Use `.env.example` as the canonical Koed environment example. It is the starting point for local and production deployments.

The README Quickstart covers the basic bundled-local setup and packaged Desktop first-run. This page is the advanced reference for environment variables, runtime modes, external dependency URLs, and production settings.

For any local deployment, start by running:

```bash
pnpm env:setup
```

This creates `.env` and generates `API_DATA_ENCRYPTION_KEY`,
`API_TOKEN_PEPPER`, `EMBEDDING_SERVICE_TOKEN`, `PRIVACY_SERVICE_TOKEN`, and a
local `POSTGRES_PASSWORD`. If `.env` already exists, the command preserves
existing values and adds any missing keys from `.env.example`.
It also migrates the old documented accelerator allocation defaults—32,768
embedding context tokens and 8,192-token microbatches—to the safer 8,192-token
context and 512-token microbatch values. Other explicit Operator overrides are
preserved.

For server/private VPS deployments, treat `koed-server` as the application
deployment unit and Postgres, queue backend, Embedding Service, reverse
proxy/TLS, and backup/restore jobs as dependencies. See
[server-deployment-boundary.md](server-deployment-boundary.md) for the
operator-facing boundary and migration notes.

## `koed-server` Dependency Ownership

`koed-server` reads `KOED_HOME/config/server.json` plus environment overrides.
Source checkouts default to `runtimeMode: "developer"` and
`dependencyMode: "external"`.

Configuration precedence is deterministic: values already present in the
launching process environment take precedence over app-local `.env` files,
which are loaded with overwrite disabled. For `koed-server` mode and dependency
settings, explicit process-environment values also override
`KOED_HOME/config/server.json`; absent values fall back to that file and then to
documented defaults. API and Worker processes in one deployment must be started
from the same resolved environment. Changing `.env` after startup has no effect
until the affected processes are restarted.

External dependency mode means the Operator manages Postgres, Redis/BullMQ, the
Embedding Service, and the Privacy Service lifecycle. The services may be
launched by Docker Compose, systemd, Homebrew, managed infrastructure, or
another Operator-managed path.
`koed-server` connects to those services and supervises Koed app processes; it
does not start or stop Docker Compose in this mode.

Bundled-local dependency mode is a native local runtime for Postgres/pgvector,
the Embedding Service, and the pinned Privacy Service. In this mode,
`koed-server start` starts Koed-owned native runtimes under `KOED_HOME`; it never
starts Docker Compose. API/Worker jobs default to `WORK_QUEUE_BACKEND=local`, so
Redis is not required for queues unless the Operator explicitly sets
`WORK_QUEUE_BACKEND=bullmq`. With BullMQ, Redis is Operator-managed external
infrastructure. Native local personal mode stores data, queue state, logs,
model files, Postgres data, and runtime state under `KOED_HOME`. Required
native binaries and pinned model files still need to exist through the current
local setup path.

Supported mode fields:

- `KOED_DEPLOYMENT_PROFILE`: capability profile reported by
  `/v1/capabilities`. Supported values are `developer`, `local_personal`,
  `private_vps`, `team_self_hosted`, and `koed_managed_cloud`. Hyphenated
  aliases such as `local-personal`, `private-vps`, `team-self-hosted`, and
  `koed-managed-cloud` are accepted. If omitted, `local-personal` runtime mode
  reports `local_personal`; other source checkout runs report `developer`.
- `KOED_RUNTIME_MODE`: `local-personal`, `external`, or `developer`.
- `KOED_TEAM_COLLABORATION_ENABLED`: the shared API/Worker Team collaboration switch.
  It accepts only `true` or `false`. Operator-managed server deployments default
  to `false`. A Desktop-managed local edge also defaults to `false`, so a
  packaged Desktop install starts Personal-only and does not provision the
  Privacy Filter model. To enable its Team collaboration client, the Operator
  must explicitly launch Desktop with `KOED_TEAM_COLLABORATION_ENABLED=true`;
  this provisions the Privacy Filter model and enables the local Team routes
  after restart. Upgrading an existing Desktop installation preserves an
  explicit environment value; otherwise, Team collaboration becomes disabled
  until this opt-in is supplied. When disabled,
  Desktop presents a Personal-only interface: Team rail entries, navigation,
  commands, sharing actions, connection preferences, and add-or-join actions
  are absent. Retained Team selections and navigation history reconcile to a
  Personal route rather than exposing cached Team state.
  capability discovery reports Team Workspaces, collaboration, Share Grants,
  Cross-Identity Sync, remote upstreams, and device enrollment unavailable.
  Team chat, Shared Memory, Team realtime, retention, high-risk, support, Team
  lifecycle, Cross-Identity Sync, enrollment, and upstream local-edge requests
  receive an empty `404` before repository access, content materialization,
  mutation, or upstream routing. Scope-discriminated realtime acknowledgements
  may validate and decrypt the signed cursor only to reject a Team scope.
  Personal Memory capture, recall, graph, API Token, session APIs, Personal
  notes and channels, Personal realtime, and the local Personal broker remain
  available. Neither Pending Share worker family is constructed, drained, or
  scheduled while this switch is false: accepted work remains durable and
  unavailable until the Operator re-enables Team collaboration and restarts the
  service. Shutdown is valid when those worker timers were never created. The
  Worker continues Personal Projection, embedding, LCM, and
  deletion reembedding, but does not start Cross-Identity Sync, retention purge,
  collaboration replay pruning, Privacy Filter infrastructure, or other Team
  collaboration jobs. External mode does not require Privacy Filter URLs or
  credentials while this switch is false. Bundled-local and Desktop do not
  start the Privacy Filter Service or require its model while this switch is
  false. Restart the supervisor, API, and Worker after changing the value.
- `KOED_DEVELOPER_TEAM_BACKEND_ENABLED`: an isolated local-testing switch that
  lets the `developer` deployment profile truthfully advertise and serve the
  Team backend capability foundation. It accepts only `true` or `false`,
  defaults to `false`, requires `KOED_TEAM_COLLABORATION_ENABLED=true`, and is
  ignored by every non-developer deployment profile. Do not enable it for a
  production deployment. When enabled, the isolated developer backend reports
  Cross-Identity Sync available only while application-layer encryption and
  the Cross-Identity Sync Worker are ready. It does not relax the verified
  WorkOS/AuthKit identity requirement for Team Self-Hosted or Koed-managed
  cloud.

Authentication providers are part of the deployment capability contract.
Private VPS and Team Self-Hosted profiles expose local session authentication;
when WorkOS/AuthKit is configured, Team Self-Hosted exposes it instead of
local session authentication. Local setup, registration, and password-login
routes are unavailable while WorkOS/AuthKit is the configured provider.
Koed-managed cloud never advertises local session authentication and exposes
WorkOS/AuthKit only when it is configured. Local session authentication alone
does not establish verified Team identity. Outside the isolated `developer`
profile, Team creation, high-risk Team administration, and invite acceptance
require a current verified WorkOS/AuthKit identity in the configured provider
environment whose email matches the local User and, for invite acceptance, the
email-bound, backend-bound, one-time invite token. A deployment without that
verified identity path remains fail-closed for those Team-authority operations.
The verified identity establishes who the User is; Koed Team Membership and
roles determine what that User may do. A Personal API Token is a User-owned AI
Client integration credential. It is neither a Team backend identity nor an
Operator or Team administrative credential.

- `KOED_DEPENDENCY_MODE`: `external` or `bundled-local`.
- `MEMORY_CODEX_TRANSCRIPT_WATCHER_ENABLED`: enables the supervised Codex Transcript Watcher. When unset, developer and local-personal runtime modes enable it. External runtime mode cannot enable it because that mode does not own a Local AI Runtime; attempting to do so fails configuration. `KOED_HOME/config/server.json` may set the equivalent `codexTranscriptWatcherEnabled` field, with the environment taking precedence.
- `MEMORY_CLAUDE_TRANSCRIPT_WATCHER_ENABLED`: enables the Claude Transcript Watcher in the same supervised Local AI Runtime. It has the same runtime-mode defaults and environment-over-file precedence; the equivalent server config field is `claudeTranscriptWatcherEnabled`.
- `MEMORY_PI_TRANSCRIPT_WATCHER_ENABLED`: enables Pi Transcript Watcher in same Local AI Runtime. Default enabled. Filesystem discovery remains correctness path even when Pi extension is disabled.
- `KOED_EXTERNAL_DATABASE_URL` or `DATABASE_URL`: Operator-managed Postgres URL in external mode.
- `KOED_EXTERNAL_REDIS_URL` or `REDIS_URL`: Operator-managed Redis/BullMQ URL when the queue backend is `bullmq`.
- `KOED_EXTERNAL_EMBEDDING_SERVICE_URL` or `EMBEDDING_SERVICE_URL`: Operator-managed Embedding Service URL in external mode.

Example external `KOED_HOME/config/server.json`:

```json
{
  "runtimeMode": "external",
  "dependencyMode": "external",
  "codexTranscriptWatcherEnabled": false,
  "claudeTranscriptWatcherEnabled": false,
  "external": {
    "databaseUrl": "postgres://koed:password@127.0.0.1:15432/koed",
    "redisUrl": "redis://127.0.0.1:16379",
    "embeddingServiceUrl": "http://127.0.0.1:3800"
  }
}
```

Example bundled-local `KOED_HOME/config/server.json`:

```json
{
  "runtimeMode": "developer",
  "dependencyMode": "bundled-local",
  "codexTranscriptWatcherEnabled": true,
  "claudeTranscriptWatcherEnabled": true
}
```

`koed-server setup core --json` is the client-neutral Operator bootstrap. It
creates or reuses and validates the local API Token used privately by the
Local AI Runtime. It does not write final verification state; `doctor --json`
persists final success or failure. `koed-server setup codex --json`, `setup claude`, and
`setup pi` are explicit client-profile commands and are not run by core setup.
The Desktop supervisor may provision the same local credential automatically;
manual token bootstrap remains supported.

`koed-server status --json` and `doctor --json` report core components separately
from AI Client profile diagnostics. In `developer` and `local-personal` runtime
modes, core includes API, storage, queues, Embedding Service, Local AI Runtime
process, MCP artifacts, and its local Personal API Token. In `external` runtime
mode, core does not own a Local AI Runtime and does not require
`MEMORY_API_TOKEN`; a missing, invalid, or revoked Personal API Token remains
visible as Diagnostic Status without making the server unhealthy. Zero
configured AI Clients is healthy core state. Codex, Claude Code, and Pi
configuration, authentication, Capture Hook, Transcript Watcher, and synthesis
readiness remain client diagnostics. LCM Summary Service process health is
reported separately from any assigned AI Client/model. Doctor prints all client
diagnostics, but only core failures affect `ok`, `state`, and exit status.

AI Client instances are written to the local registry after explicit profile
setup succeeds. One-time core migration also registers `codex.default` when an
existing Codex config contains Koed's ownership marker and the registry lacks
Codex; it preserves existing registry entries and config bytes. Unrelated
detection never selects a client or edits its profile. Existing Codex configuration, API Token, and Personal Memory remain
in place.

AI Client registration resolves the executable before writing it to the
registry. Koed first uses the client's non-empty explicit override, then
searches the inherited `PATH`. On macOS, Codex, Claude Code, and Pi discovery
additionally searches `~/.local/bin`, `/opt/homebrew/bin`, and `/usr/local/bin`,
in that order. Koed does not start an interactive shell for discovery. The
registry stores the resulting stable absolute launcher path so the Local AI
Runtime does not need to search `PATH` again. Koed resolves the launcher's
current target at execution time, allowing package upgrades to retarget it.
Node-based CLI entries are invoked through Koed's trusted Node runtime, so npm
launchers do not depend on `/usr/bin/env node` finding Node in Finder's minimal
`PATH`. Pi retains its additional canonical-target and npm shim validation.

## Clone-Safe Local Device Identity

On first local control-plane use, `koed-server` creates opaque stable
`deploymentId` and `deviceInstanceId` values. Ordinary identity state lives at
`KOED_HOME/config/device-identity.json`; it contains IDs, a host-proof reference,
a public fingerprint, and non-secret status metadata only. It never contains raw
proof material.

Raw host proof is stored outside `KOED_HOME` by the platform proof-store
implementation: `~/Library/Application Support/Koed/device-proof` on macOS,
`$XDG_STATE_HOME/koed/device-proof` (or `~/.local/state/koed/device-proof`) on
Linux/WSL, and `%LOCALAPPDATA%/Koed/device-proof` on Windows. Set
`KOED_DEVICE_PROOF_DIR` only to select another user-private directory outside
`KOED_HOME`, such as isolated test state. This file-backed store is not an OS
keychain and is distinct from API Tokens, upstream credentials, Local-Edge
Client Credentials, and Personal Device Group governance material.

On POSIX, Koed requires owner-only proof directories/files and identity-state
files (no group/other permission bits; current-user ownership; no symlinks).
Unsafe, missing, malformed, or mismatched proof/state never regenerates or
rotates identity automatically. First boot writes a durable bootstrap journal in
`KOED_HOME/config`, not disposable `KOED_HOME/run`, before proof or state
mutation. A copied `KOED_HOME` without matching host proof therefore enters
clone quarantine: local capture, Personal Memory, and Recall continue, while
enrollment, sync, Team, and remote local-edge work fail closed. Copying to a
new path on same host also fails because proof binds keyed canonical
`KOED_HOME`; proof, paths, and fingerprints never appear in status.

Windows path selection uses user-local application state, but Node cannot verify
all ACL inheritance and ownership guarantees with this implementation. Windows
therefore reports `platformProtection: "limited"` and fails remote operations
closed. Operators should enforce user-only ACLs and avoid shared profiles.

No local proof can distinguish a perfect full-machine clone or restored image at
the same canonical path. Remote service collision detection and explicit
re-enrollment remain required for that case.

During upgrade, API startup adopts an existing local Cross-Identity Sync
protocol deployment ID into freshly bootstrapped device identity once. This
preserves existing relationships and transport references without rewriting the
database identity. After adoption, any mismatch fails closed. Status reports
proof placement inside `KOED_HOME` as `unsafe_proof_storage` with move-storage
remediation; owner, mode, or symlink problems remain `unsafe_proof_permissions`
with permission remediation.

Inspect or explicitly repair identity with machine-readable output:

```bash
koed-server identity status --json
koed-server identity rotate --json
```

`identity rotate` preserves verified deployment ID, creates a fresh device ID
and proof, preserves local Memory, and disables local upstream route policies.
It revokes/removes locally stored enrollment references where possible. Koed
never self-revokes remote credentials without upstream authority: if one may
remain active, rotation stays `repair_required` with redacted
`pendingRemoteRevocation: true`; it does not report healthy. Revoke upstream
credential through authorized remote flow, run `identity rotate` again as
Operator acknowledgement, then explicitly re-enroll. Status redacts proof
material, proof references, paths, and fingerprints.

## Personal Device Sync V1 authority configuration

PDS uses explicit secret-provider mode. Headless setup requires
`PDS_SECRET_PROVIDER=headless` and `PDS_SECRET_PROVIDER_COMMAND`; Koed invokes
that Operator-managed provider with a bounded `get`, `put`, or `delete`
operation and an opaque reference. Provider `put` receives generated material
on stdin and `get` returns it on stdout inside the local process boundary. No
secret appears in command arguments, ordinary
configuration, status, logs, queue payloads, or `KOED_HOME` state.

Packaged Desktop provisions a separate local Authority signing key through its
platform-backed provider and gives the trusted local API child only the opaque
`PDS_AUTHORITY_SECRET_REF`. This enables the co-located local-only
Authority/Relay service role without placing Authority material in the device
runtime secret, renderer IPC, or ordinary configuration. It does not change
the active-device or recovery-root authorization required for governance.

Desktop configures its provider automatically. It uses Keychain on macOS,
DPAPI on native Windows, and Electron's verified Secret Service/KWallet backend
on Linux. WSL uses a narrowly scoped Windows-host DPAPI helper when its Windows host is
available, so normal WSL users do not need to install or configure a Linux
keyring daemon. The direct local `koed-server` and Worker children receive only
a per-launch bridge capability and may perform bounded opaque-reference
operations; they do not receive PDS secret values. Electron's Linux
`basic_text` fallback is rejected. If no platform provider is usable, Desktop
reports PDS unavailable while local capture and Recall remain usable; it never
stores PDS material in plaintext or asks a User to put it in an environment
variable. Never set raw `PDS_AUTHORITY_*`, group keys, recovery material,
private keys, passwords, or `env://` PDS secret values.

Desktop loads its window before it accesses this provider. Provider setup still
finishes before the managed runtime starts, so children never start with a
partially initialized secret bridge. This order keeps the window available when
the operating system pauses for credential-provider interaction.

PDS relay capability additionally requires usable Authority state and migrated
relay repository. Relay requests authenticate only with an unexpired
Authority-signed `pds_relay` membership certificate plus a domain-separated
Ed25519 request proof; API Tokens, browser sessions, and `Koed-Device` do not
authorize relay traffic. Authority may be temporarily unreachable while a valid
certificate remains unexpired; stale, expired, revoked, wrong-head, and
wrong-epoch certificates fail closed.

Every relay action rereads and locks current Group, active member, certificate,
head, epoch, and no-pending-epoch state in same database transaction as relay
mutation/read. Revocation or epoch transition wins races; stale actions fail
closed. Recipient reads also bind current recipient state to intended snapshot.

Relay stores canonical encrypted transport/package bytes and bounded opaque
metadata only while active. Runtime resolves secret reference only inside
process boundary; route/worker queue payloads contain encrypted package IDs and
opaque work IDs only. Durable database notifications, exact retry timers, and
an authenticated long-lived relay wake request drive reconciliation. It never
polls or enables a fallback provider.

Expiry and seven-day post-quorum ACK cleanup delete
ciphertext chunks and recipient envelopes, retaining only redacted receipt
metadata; tombstones remain reserved. It does not decrypt, project, embed,
recall, inspect Project aliases, or access Team state. API Tokens, device
credentials, Cross-Identity Sync configuration, and RSA envelope settings do
not authorize PDS relay.

## Local Edge Upstream Registry

Local edge `koed-server` stores remote/private/cloud upstream backend metadata
under `KOED_HOME/config/upstream-backends.json`. This registry is first-class
local configuration, not a loose environment-variable convention. It stores the
upstream id, display name, base URL, deployment profile, cached public
capabilities, validation timestamps, credential status/reference metadata, and
route-policy metadata. It also stores one explicit `activeBackendId` for Desktop
and implicit local-edge Team routing. Registry array order is never authority;
an operation without an explicit backend id fails closed when no active backend
is selected. Connecting selects the enrolled backend, while cancellation,
disconnect, or removal clears the selection when it targets that backend.

The registry must not contain reusable upstream credentials, WorkOS secrets,
API Tokens, device secrets, bearer tokens, token prefixes, or database
credentials. Upstream URLs with username/password material, query strings, or
fragments are rejected. Remote upstreams must use HTTPS; HTTP is accepted only
for exact loopback targets (`localhost`, `127.0.0.1`, or `::1`) used by local
development. Upstream requests reject redirects so an accepted endpoint cannot
downgrade credential or Memory traffic. Each outbound request resolves its host
once, rejects forbidden, link-local, metadata, disguised-loopback, and mixed
network-trust targets, and pins the approved address for the connection. Private
network targets are accepted only when their exact registered backend is marked
`private_vps` or `team_self_hosted`; managed-cloud registrations remain
public-network only. Device/upstream credential material is handled by the
separate credential model; this registry only records non-secret existence and
status metadata.

Live local-edge upstream proxying needs separate upstream relay authorization.
The registry may record a sanitized credential `reference`, but the reusable
secret must live in the encrypted local credential store or deployment secret
storage. Browser-mediated upstream enrollment writes a `keychain://koed-upstream/...`
reference into the registry and stores the reusable device secret separately
under `KOED_HOME/secrets` with owner-only file permissions. That reference is an
opaque compatibility identifier for Koed's encrypted file store; current shared
credential storage is not an OS keychain. At runtime the API
resolves that reference from the local credential store; when no reference is
configured it falls back to `KOED_UPSTREAM_CREDENTIAL_<BACKEND_ID>`, where the
backend id is uppercased and non-alphanumeric characters become `_`. The value
may be a full `Bearer ...` or `Koed-Device ...` authorization header, or a
`key:secret` value which is sent as `Koed-Device key:secret`. Local browser
session cookies and personal API Tokens are never forwarded upstream.

The file-backed custody implementation has one internal encrypted-state
transaction core for key handling, authenticated encryption, bounded lock
recovery, schema parsing, and durable atomic replacement. Public code consumes
separate upstream/Desktop credential custody, Local-Edge Client Credential
custody, pending Team-send persistence, and Action Grant custody capabilities;
the generic transaction core is not a package export. All four capabilities
continue to read and write the existing schema-version-1 file and key paths.
Action Grant custody keeps its legacy `state` field inside the vocabulary a
previous binary accepts and records the current approval lifecycle separately,
so unclassified and Native-review records remain rollback-readable as legacy
`pending` state without losing their current semantics. This requires no data
migration. Unknown, malformed, or undecryptable state fails closed rather than
falling back to plaintext or a weaker store. Enrollment may declare an explicit
cross-domain transaction so its upstream credential and Local-Edge Client
Credential are staged in one replacement.

Supported commands:

```bash
SOURCE_OWNER_PRINCIPAL_ID="<local-owner-user-uuid>"
koed-server upstream register --url https://koed.example.test --id team-vps --name "Team VPS" --profile private_vps --json
koed-server upstream list --json
koed-server upstream refresh --id team-vps --json
koed-server upstream policy --id team-vps --team-workspace-read enabled --share-grant-management enabled --admin enabled --json
koed-server upstream enroll start --id team-vps --source-owner-principal-id "$SOURCE_OWNER_PRINCIPAL_ID" --json
koed-server upstream enroll status --id team-vps --json
koed-server upstream enroll cancel --id team-vps --json
koed-server upstream disconnect --id team-vps --json
koed-server upstream remove --id team-vps --json
```

Capability refresh calls the upstream public `/v1/capabilities` endpoint,
requires the versioned Koed capability schema, and records `validated`,
`stale`, `failed`, or `not_checked` cache state. The cache expires after the
local freshness window and status/doctor report stale or failed caches as
attention items. While Koed Desktop is connected, its local collaboration
broker revalidates the active backend before that window expires and retries a
failed refresh without accepting stale capabilities. Headless Operators can use
`upstream refresh` to revalidate explicitly. Route-policy defaults are
fail-closed: registering an upstream
does not enable capture-bearing writes, Team Workspace recall, Share Grant
management, sync/offload, or admin operations. Operators must explicitly enable
allowed operation families with `koed-server upstream policy`; later routing and
sync work must consume the cached capabilities and route policy before enabling
remote-dependent surfaces. Enabling the `--admin` route policy for
browser-mediated enrollment requests the narrow `action_grant` device family,
not reusable `admin` authority. Every resulting administration request still
requires an exact one-use grant produced by fresh browser confirmation.

Enrollment orchestration state is separate from the upstream backend registry.
`upstream enroll start/status/cancel` and `upstream disconnect` record only
non-secret local state under `KOED_HOME/run/upstream-enrollments.json`, including
state, requested operation families, timestamps, and credential status/reference
metadata. Each record also carries a transaction identity, monotonically
increasing backend-local generation, phase, and distinct active and pending
credential references. `upstream enroll start` first commits a non-authoritative
prepared transaction and encrypted pending custody under the per-backend lock,
then creates a short-lived browser approval challenge on the upstream backend
and records its activation URL. After the user
approves the challenge in a browser session, `upstream enroll status` validates
the scoped device credential with the upstream backend and marks the local
backend credential configured. Koed Desktop performs that reconciliation
automatically during its normal bounded status refresh cycle. The CLI command
remains available for headless operation and diagnostics. Desktop also displays
the activation URL so Linux/WSL Users can open it manually if host-browser
integration is delayed or unavailable. API Tokens remain personal AI-client
compatibility credentials. Team Workspace recall through MCP uses a distinct
Local-Edge Client Credential scoped to the selected backend and
`team_workspace_read`. The local edge validates that credential, then uses the
separate enrolled upstream device credential without exposing it to MCP. A
Personal API Token alone is rejected from Team, Share Grant, sync, and admin
operation families. Enrollment status, replacement, cancellation, recovery, and
disconnect mutations are serialized per backend across CLI processes. Remote
requests run outside the lock, while every authority-changing effect is preceded
by a durable transaction decision and every final state commit occurs under the
same lock after rereading transaction identity and generation. Interrupted
preparation is compensated; interrupted commit or abort effects resume
idempotently. Replacement commits the successor into the registry before
deleting predecessor custody, and temporary remote uncertainty retains the
active credential.

`KOED_TEAM_WORKSPACE_AUTO_RESOLUTION_ENABLED=true` lets the MCP Server resolve
an explicit local Project-to-Team Workspace mapping when `memory_answer` receives
a Project-scoped request without a `team_workspace_id`. Personal Memory remains
the default, and the mapped Team path still requires enrolled local-edge and
upstream device credentials. See `docs/team-workspace-project-mapping.md`.

## KOED_HOME Layout

Koed-owned local state lives under `KOED_HOME`:

- `config/` for `server.json`, `local-ports.json`, `local-app-credential.json`,
  non-secret `device-identity.json`, local Project metadata in `projects.json`,
  and Project-to-Team Workspace mappings in `project-team-workspaces.json`
- `run/` for `koed-server.json`, `last-verification.json`, identity bootstrap
  marker/lock state, upstream enrollment orchestration state, and native runtime
  state
- `logs/` for service logs, including `postgres.log`
- `data/` for native database files, including `data/postgres`
- `models/` for embedding and reranker model files
- `cache/` for installer metadata and downloaded artifact cache
- `runtime/` for bundled or packaged native runtime binaries

Packaged Desktop, headless local-personal startup, and repair commands all read and write this same layout. Host proof is deliberately excluded from this layout so copying it alone cannot copy usable device identity.

## Platform Expectations

- macOS: packaged Desktop and bundled-local provisioning path.
- Linux and WSL: headless development, smoke, and the same CLI contracts when bundled-local runtime assets are available. Packaged Linux native assets require glibc 2.35+ on Ubuntu 22.04/Debian 12 or newer. Keep `KOED_HOME` and checkout paths on Linux filesystem paths inside WSL, not `/mnt/<drive>`.
- Native Windows packaged app support: not shipped in this build; use WSL for local development. Windows host browsers can reach Koed through WSL localhost forwarding when available, or by browsing the WSL IP directly as a fallback.

## Required Deployment Values

- `POSTGRES_DB`: Postgres database name used by Docker Compose.
- `POSTGRES_USER`: Postgres user used by Docker Compose.
- `POSTGRES_PASSWORD`: Postgres password. `pnpm env:setup` generates this for
  local Docker Compose deployments. Use a deployment-specific secret for
  production.
- `POSTGRES_HOST_PORT`: host port mapped to the Postgres container.
- `DATABASE_URL`: local Postgres URL used by operator scripts such as
  `pnpm api-token:create`. Docker Compose derives service-internal database URLs
  from `POSTGRES_DB`, `POSTGRES_USER`, and `POSTGRES_PASSWORD`. Hosted
  `koed-server` traffic should use the runtime Postgres role; use the migration
  role only for `pnpm --filter @koed/db migrate:up`. See
  [hosted-database-roles.md](hosted-database-roles.md).
- `API_NODE_ENV`: runtime environment for the internal API app. Use
  `production` for deployed `koed-server` runs.
- `API_HOST`: API bind host for direct local runs. Defaults to `127.0.0.1` in development and `0.0.0.0` in production. Override only when you intentionally want LAN access.
- `API_HOST_PORT`: host port used by the local API process supervised by `koed-server`. The API listens on process-local `API_PORT`.
- `API_LOG_LEVEL`: API log level. See [observability](observability.md) for
  the structured API log schema and redaction rules.
- `API_DATA_ENCRYPTION_KEY`: base64 32-byte key used by the `local_test_key`
  envelope provider for local development, private/operator-managed, and non-paid
  operator-managed deployments. It is not the paid Koed-managed cloud KMS.
- `API_ENVELOPE_ENCRYPTION_PROVIDER`: envelope provider mode. Defaults to
  `local_test_key`; paid Koed-managed cloud must use a KMS-backed mode:
  `managed_kms`, `byok`, or `cmek`. Premium customer-controlled modes `byok`
  and `cmek` use the same provider contract but require a customer
  key-reference onboarding flow before use. `operator_kms` is reserved for
  Team Self-Hosted/private VPS KMS integration and is not implemented in this
  build.
- `KOED_MANAGED_CLOUD_RELEASE_STAGE`: `alpha` or `paid`. Team Self-Hosted,
  private VPS, and Koed-managed cloud profiles store new human-readable Memory
  payloads through encrypted field companions and keep operational source
  columns redacted. When this is set to `paid` with
  `KOED_DEPLOYMENT_PROFILE=koed_managed_cloud`, the API and Worker refuse to
  start unless `API_ENVELOPE_ENCRYPTION_PROVIDER` is KMS-backed.
- `MANAGED_KMS_KEY_ID` and `MANAGED_KMS_KEY_VERSION`: safe managed KMS key
  reference metadata required when the API or Worker is configured for
  `managed_kms`, `byok`, or `cmek`.
- `MANAGED_KMS_ENDPOINT_URL` and `MANAGED_KMS_AUTH_TOKEN`: managed KMS
  wrap/unwrap endpoint and bearer credential for the generic HTTPS KMS adapter.
  The endpoint must use HTTPS unless it targets localhost for local tests. KMS
  credentials and key material must live in deployment secret management, not in
  app rows, diagnostics, logs, or client-visible configuration.
  After a KMS key version is rotated, run `pnpm hosted:encryption-rewrap` in
  bounded batches to rewrap encrypted-field DEKs to the configured current key
  version without rewriting plaintext payload bytes. Use
  `pnpm hosted:encryption-rewrap --dry-run` first to count the exact matching
  rows without invoking rewrap or changing envelope metadata.
- `OWNER_PRIVATE_REPLICA_DATA_ENCRYPTION_KEY`: independent base64 32-byte key
  for owner-private remote replica payloads when their provider mode is
  `local_test_key`. `pnpm env:setup` and packaged local startup generate this
  separately from `API_DATA_ENCRYPTION_KEY` on first setup and retain it across
  later runs.
- `OWNER_PRIVATE_REPLICA_ENVELOPE_ENCRYPTION_PROVIDER`: owner-private replica
  provider mode. It supports `local_test_key`, `managed_kms`, `byok`, and
  `cmek`, matching the implemented Team/general provider modes. Owner-private
  operations never fall back to `API_ENVELOPE_ENCRYPTION_PROVIDER`; when this
  family is absent, those operations fail closed while the alpha API may still
  start.
- `OWNER_PRIVATE_REPLICA_MANAGED_KMS_KEY_ID`,
  `OWNER_PRIVATE_REPLICA_MANAGED_KMS_KEY_VERSION`,
  `OWNER_PRIVATE_REPLICA_MANAGED_KMS_ENDPOINT_URL`, and
  `OWNER_PRIVATE_REPLICA_MANAGED_KMS_AUTH_TOKEN`: isolated KMS key reference,
  wrap/unwrap endpoint, and bearer credential used for owner-private replicas
  in `managed_kms`, `byok`, or `cmek` mode. These values are required together
  for a KMS-backed owner-private provider and are never inherited from
  `MANAGED_KMS_*`.
- `TEAM_MEMORY_DATA_ENCRYPTION_KEY` and
  `TEAM_MEMORY_ENVELOPE_ENCRYPTION_PROVIDER`: the independent Team
  representation key family. Explicit Team Curated Memory requires this
  provider and rejects a key ID shared with either the Personal/base or
  owner-private replica provider. The supported modes match the other envelope
  families.
- `TEAM_MEMORY_MANAGED_KMS_KEY_ID`,
  `TEAM_MEMORY_MANAGED_KMS_KEY_VERSION`,
  `TEAM_MEMORY_MANAGED_KMS_ENDPOINT_URL`, and
  `TEAM_MEMORY_MANAGED_KMS_AUTH_TOKEN`: isolated Team Memory KMS settings for
  `managed_kms`, `byok`, or `cmek`. They are never inherited from the Personal
  or owner-private KMS families.
- `API_TOKEN_PEPPER`: Operator-controlled server-side pepper used when hashing
  API Tokens. It is a required server secret, not a User identity, Personal API
  Token, or administrative account.
- `API_CORS_ORIGINS`: comma-separated exact browser origins, including scheme,
  host, and port. Cookie-authenticated Shared Memory,
  retention, high-risk activation, Team, Workspace, and invite writes require
  an explicitly allowed `Origin` or `Referer`. When both headers are present,
  both must be valid, allowed, and identify the same origin. When Fetch Metadata
  is present, these high-risk writes require `Sec-Fetch-Site: same-origin`;
  malformed, `same-site`, `cross-site`, and `none` evidence is rejected. Scoped
  device credentials and API Tokens do not require browser-origin evidence.
- `API_REQUEST_BODY_LIMIT_BYTES`: maximum API request body size. Default `4194304`.
- `API_AUTH_RATE_LIMIT_WINDOW_MS`: auth rate-limit window.
- `API_AUTH_RATE_LIMIT_MAX`: auth requests allowed per window.
- `API_MEMORY_RATE_LIMIT_WINDOW_MS`: fallback API-token memory rate-limit window. The default window is 60 seconds.
- `API_MEMORY_RATE_LIMIT_MAX`: fallback API-token memory requests allowed per window. The default is 1000 requests per 60-second window, which is intended to absorb local Desktop and MCP Server bursts in a Koed deployment without changing the stricter auth rate limit.
- `API_MEMORY_WRITE_RATE_LIMIT_MAX`: write-oriented memory requests allowed per window. The window uses `API_MEMORY_RATE_LIMIT_WINDOW_MS`; the default max is 300 requests per 60-second window.
- `API_SOURCE_JOURNAL_RATE_LIMIT_WINDOW_MS`: window for authenticated local conversation-source journal transfer. This workload has an independent bucket so first-run source replication cannot consume interactive Memory read/write capacity. The default is 60 seconds.
- `API_SOURCE_JOURNAL_RATE_LIMIT_MAX`: local conversation-source journal requests allowed per journal window. The default is 10,000; the journal routes remain API-token authenticated and unavailable outside developer and Local Personal deployment profiles.
- `API_MEMORY_RECALL_RATE_LIMIT_MAX`: recall-oriented memory requests allowed per window. The window uses `API_MEMORY_RATE_LIMIT_WINDOW_MS`; the default max is 300 requests per 60-second window.
- `API_RATE_LIMIT_STORE`: `memory` by default for direct/local runs; set `redis`
  to share API rate-limit counters across API replicas. The server/private-VPS
  Compose wrapper defaults this to `redis`.
- `API_RATE_LIMIT_REDIS_URL`: optional Redis URL for API rate-limit counters; falls back to `REDIS_URL`.
- `API_CACHE_STORE`: `memory` by default; set `redis` to enable short-lived graph response caching.
- `API_CACHE_REDIS_URL`: optional Redis URL for API cache entries; falls back to `REDIS_URL`.
- `API_GRAPH_CACHE_TTL_SECONDS`: graph overview/thread cache TTL when Redis caching is enabled.
- `API_GRAPH_UPDATE_DEBOUNCE_MS`: debounce window for coalescing graph stream update events.
- `API_MEMORY_EVENT_GRAPH_UPDATE_DEBOUNCE_MS`: shorter debounce window for captured event stream updates that drive the open history thread.
- `API_COLLABORATION_REALTIME_STREAM_MAX_CLIENTS`: maximum concurrent collaboration realtime clients for one API process. The default is 1000.
- `API_COLLABORATION_REALTIME_STREAM_MAX_CLIENTS_PER_PRINCIPAL`: maximum concurrent collaboration realtime clients for one authenticated principal on one API process. The default is 6.
- `API_COLLABORATION_REALTIME_CURSOR_SECRET`: signs and encrypts Personal and
  Team durable realtime cursors. It remains required when Team collaboration is
  disabled because Personal realtime remains available.
- `API_COLLABORATION_LOCAL_BROKER_SECRET`: authenticates the local Personal and
  Team collaboration broker. It remains required for non-external runtimes when
  Team collaboration is disabled because Personal broker commands and
  subscriptions remain available.
- `MEMORY_CURATED_REVIEW_PROVIDER`: local Curated Memory review provider. Supported values are `codex`, `claude`, and `pi`; default `codex`. Pi requires full provider/model ID.
- `MEMORY_CURATED_REVIEW_AI_CLIENT_INSTANCE`: selected local AI Client instance for Curated Memory Review. Default `<provider>.default`.
- `MEMORY_CURATED_REVIEW_MODEL`: model for the separate local Curated Memory reviewer. Default `gpt-5.6-luna` for Codex; Claude uses `haiku` when unset, and Pi requires an explicit full provider/model ID.
- `MEMORY_CURATED_REVIEW_REASONING_EFFORT`: reasoning effort for Curated Memory review. Default `low` for Codex; `none` for Claude's default `haiku` model, which does not support an explicit reasoning-effort level.
- `MEMORY_CURATED_REVIEW_TIMEOUT_MS`: maximum duration of one local review call. Default `90000`.
- `MEMORY_CURATED_REVIEW_MAX_ATTEMPTS`: maximum review attempts before a non-stale worker failure becomes a rejection. Default `2`.
- `MEMORY_CURATED_REVIEW_MAX_PROMPT_TOKENS`: maximum complete review-bundle size. Oversized evidence fails closed instead of being truncated. Default `24000`.
- `MEMORY_CURATED_REVIEW_INITIAL_DELAY_MS`: delay before the local service first checks pending proposals. Default `5000`.
- `MEMORY_CURATED_REVIEW_PUSH_DELAY_MS`: debounce after the proposal tool nudges the local service. Default `250`.
- `MEMORY_CURATED_REVIEW_INTERVAL_MS`: recovery scan interval for pending or expired review leases. Default `60000`.
- `MEMORY_CURATED_REVIEW_BATCH_LIMIT`: maximum proposals leased by one service pass. Default `3`, maximum `20`.
- `API_COOKIE_SECURE`: set `true` behind HTTPS; local HTTP development may use `false`.
- `KOED_BACKUP_STATUS_PATH`: optional path to a redacted JSON backup status file consumed by `/ops/status`. When omitted, backup freshness is reported as `not_configured`.
- `KOED_BACKUP_MAX_AGE_SECONDS`: maximum acceptable age for `lastSuccessfulAt` in the backup status file. Default `86400`.
- `KOED_OPS_REQUEST_METRICS_STATUS_PATH`: optional path to a redacted JSON request-metrics status file consumed by `/ops/status`. This is the integration point for reverse proxy, load balancer, or external telemetry jobs that calculate request latency and error-rate health.
- `KOED_OPS_REQUEST_METRICS_MAX_AGE_SECONDS`: maximum acceptable age for `checkedAt` in the request-metrics status file. Default `300`.
- `KOED_OPS_MAX_RSS_BYTES`: maximum acceptable API process resident set size before `/ops/status` reports runtime resource pressure. Default `1610612736`.
- `KOED_OPS_OPERATOR_EMAILS`: comma-separated allowlist of browser-session email addresses that may access hosted `/ops/status` and `/ops/test-alert` in `private_vps`, `team_self_hosted`, and `koed_managed_cloud` profiles. Local personal/developer profiles do not require this allowlist.
- `KOED_OPS_METRICS_TOKEN`: dedicated monitoring-service bearer credential for the private `/internal/metrics` OpenMetrics endpoint. Keep this identity separate from User sessions, API Tokens, Capture Hook credentials, and device credentials. Do not route the endpoint through the public gateway.
- `KOED_RUNBOOK_BASE_URL`: optional base URL used by `/ops/status` to attach runbook links to generated operational alerts.
- `KOED_OPS_ALERT_WEBHOOK_URL`: optional HTTPS webhook endpoint used by `/ops/test-alert` to validate alert delivery. `/ops/status` reports only that a webhook sink is configured; it does not disclose the URL.
- `KOED_OPS_ALERT_WEBHOOK_TOKEN`: optional bearer token sent only to `KOED_OPS_ALERT_WEBHOOK_URL` during test-alert delivery. It must not appear in `/ops/status`, `/ops/test-alert` responses, diagnostics, logs, or support exports.
- `KOED_CAPACITY_API_TOKEN`: optional API Token consumed by `pnpm hosted:capacity -- run` for personal capture and recall load checks.
- `KOED_CAPACITY_SESSION_COOKIE`: optional browser session Cookie header consumed by `pnpm hosted:capacity -- run` for private operations-status and Team Workspace recall load checks.
- `KOED_CAPACITY_DEVICE_CREDENTIAL`: optional scoped `Koed-Device` credential consumed by `pnpm hosted:capacity -- run` for Team Workspace device-route and local-edge proxy load checks.
- `KOED_CAPACITY_TEAM_WORKSPACE_ID`: optional Team Workspace id consumed by `pnpm hosted:capacity -- run` for Team Workspace recall and local-edge proxy scenarios.
- `KOED_CAPACITY_UPSTREAM_BACKEND_ID`: optional local-edge upstream backend id consumed by `pnpm hosted:capacity -- run --scenario local-edge-team-recall`.
- `KOED_LAUNCH_BASE_URL`: optional running API target consumed by `pnpm team-launch:validate --with-staged-remote`.
- `KOED_LAUNCH_SESSION_COOKIE`: optional browser session Cookie header consumed by staged launch validation for Team Workspace routes.
- `KOED_LAUNCH_DEVICE_CREDENTIAL`: optional scoped `Koed-Device` credential consumed by staged launch validation for Team Workspace routes.
- `KOED_LAUNCH_API_TOKEN`: optional API Token consumed by staged launch validation to prove Team Workspace recall rejects API Tokens.
- `KOED_LAUNCH_TEAM_WORKSPACE_ID`: optional Team Workspace id consumed by staged launch validation; defaults to the synthetic fixture Workspace.
- `KOED_LAUNCH_TEAM_NODE_ID`: optional Memory node id consumed by staged launch validation; defaults to a synthetic fixture node.
- `KOED_LAUNCH_LOCAL_EDGE_BASE_URL`: optional local-edge API target consumed by staged launch validation for proxy probes.
- `KOED_LAUNCH_LOCAL_EDGE_BACKEND_ID`: optional registered upstream backend id consumed by staged launch validation for proxy probes.
- `WORKOS_AUTHKIT_ENABLED`: set `true` on Team Self-Hosted backends that use WorkOS/AuthKit as their browser-session identity provider. A configured Team Self-Hosted backend exposes only WorkOS/AuthKit for browser sign-in; local setup, registration, and password-login routes are unavailable. WorkOS/AuthKit is required for verified Team invite acceptance on Koed-managed cloud. The backend still uses Koed Team Membership, Workspace Access, Share Grants, lifecycle state, and entitlement records for Memory authorization.
- `WORKOS_CLIENT_ID`: WorkOS/AuthKit client id used to build `/auth/workos/login` authorization redirects.
- `WORKOS_API_KEY`: WorkOS server API key used only by `koed-server`/API when exchanging an AuthKit callback code. It must not be exposed to browser clients, MCP Server, Capture Hook, upstream registries, logs, or diagnostics.
- `WORKOS_REDIRECT_URI`: absolute callback URL registered with WorkOS, normally ending in `/auth/workos/callback`.
- `WORKOS_PROVIDER_ENVIRONMENT`: stable namespace for WorkOS identity mappings, such as `production`, `staging`, or `default`. Provider user ids are unique only inside this namespace.

`KOED_BACKUP_STATUS_PATH` should point to JSON written by the deployment's
backup verification job. See [hosted backups](hosted-backups.md) for the
operator runbook. Example status payload:

```json
{
  "status": "ok",
  "provider": "pgbackrest",
  "checkedAt": "2026-07-03T10:00:00.000Z",
  "lastSuccessfulAt": "2026-07-03T09:55:00.000Z"
}
```

The file must not contain storage credentials, customer data, raw Memory,
database URLs, or backup object paths with embedded secrets.

`KOED_OPS_REQUEST_METRICS_STATUS_PATH` should point to redacted JSON written by
deployment telemetry or a scheduled probe. Example payload:

```json
{
  "status": "ok",
  "checkedAt": "2026-07-03T10:00:00.000Z",
  "windowSeconds": 60,
  "requestRatePerSecond": 12.5,
  "p95LatencyMs": 250,
  "p99LatencyMs": 400,
  "errorRate": 0.001
}
```

The file must not contain request bodies, prompts, raw Memory, cookies, API
Tokens, provider secrets, IP addresses unless explicitly approved by deployment
policy, or full URLs containing customer content.

- `BROWSER_PUBLIC_URL`: optional public browser-reachable base URL for the
  existing API process, used when device-enrollment links cannot be built from
  the registered backend URL. Set it to the externally reachable API URL, for
  example `https://koed.example.com` or `https://example.com/koed`. A path
  prefix is preserved in generated approval links and asset requests. It is not
  the URL of a separate browser service. Step-up and device-enrollment pages,
  authentication, and approval JSON all remain on this same origin. Its HTTP
  origin is automatically trusted for same-origin browser writes.
  With TLS termination, also configure secure cookies and make the WorkOS
  callback use this public API origin.
  Registered backend URLs may still contain a reverse-proxy base path. The
  generated activation URL and browser approval requests preserve that path.
- `REDIS_HOST_PORT`: host port mapped to the Redis dependency container when using the Docker Compose starter. Default `16379`.
- `REDIS_URL`: explicit Redis/BullMQ URL consumed by `koed-server`, API, and Worker in external dependency mode when `WORK_QUEUE_BACKEND=bullmq`. For the Docker Compose starter, use `redis://localhost:${REDIS_HOST_PORT}`.
- `WORK_QUEUE_BACKEND`: `bullmq` by default for Redis/BullMQ queues. Set `local` to use the Postgres-backed `local_work_queue` table for API/Worker jobs; this does not require Redis for job queues, though Redis may still be used for rate-limit or cache stores if configured.
- `CROSS_IDENTITY_SYNC_INTERVAL_MS`: Worker interval for durable Cross-Identity
  Sync outbox/inbox processing. Default `1000`; values below `250` are clamped.
- `CROSS_IDENTITY_SYNC_STALE_AFTER_SECONDS`: freshness duration applied after a
  successful source acknowledgement or target processing completion. Default
  `86400`. API and Worker processes for one deployment must use the same value.
  Authenticated durable heartbeats refresh inactive ready relationships;
  overdue replicas become stale and are excluded from Recall until a later
  successful package or valid heartbeat.
- `RETENTION_PURGE_INTERVAL_MS`: Worker interval for claiming and completing
  durable retention purge jobs. Default `1000`; values below `250` are clamped.
- `PRIVACY_SERVICE_URL`: authenticated internal Privacy Service URL consumed by
  the Worker. This dependency is required only when
  `KOED_TEAM_COLLABORATION_ENABLED=true`. Production Team mode requires this
  setting and fails closed for
  Team materialization when the service or pinned classifier is unavailable.
  Personal capture, Projection, LCM, embedding, and Recall continue.
- `KOED_EXTERNAL_PRIVACY_SERVICE_URL`: `koed-server` external-dependency URL
  override for the same service.
- `PRIVACY_SERVICE_TOKEN`: shared internal token required by the Privacy
  Service. Keep it in deployment secret storage and off public networks.
- `PRIVACY_RUNTIME_PROVIDER`: Privacy Filter execution preference: `cpu`,
  `auto`, `cuda`, `coreml`, or `dml`. Bundled-local operation inherits the
  product-level `KOED_HARDWARE_ACCELERATION` preference and therefore defaults
  to `auto`; an explicit value remains an Operator override. Candidate
  accelerators are verified by model load,
  final-mask parity, and warm calibration before activation. `auto` keeps CPU
  when accelerator pressure is critical or measured benefit is insufficient;
  explicit unavailable providers fail without changing the active runtime.
  Active accelerator inference failure reloads the verified CPU provider and
  retries the side-effect-free classification once. This setting does not
  change Embedding Service acceleration.
- `PRIVACY_GPU_IDLE_UNLOAD_SECONDS`: seconds of Privacy Filter accelerator
  inactivity before the model is unloaded from accelerator memory. Defaults to
  `300`; `0` keeps it resident. The next classification reloads the selected
  provider transparently. CPU inference is unaffected.
- `PRIVACY_RUNTIME_CONTROL_TOKEN`: separate internal credential for detailed
  Privacy Filter runtime diagnostics and provider changes. It is retained only
  by the supervisor/service control boundary and must not be passed to the
  Worker or other classification callers.
- `PRIVACY_FINGERPRINT_KEY`: optional stable key of at least 32 bytes for
  trust-boundary-scoped content fingerprints. Production Team mode requires
  this or derives it from `API_DATA_ENCRYPTION_KEY`/`DATA_ENCRYPTION_KEY`.
- `PRIVACY_SERVICE_TIMEOUT_MS`: Worker request timeout. Default `30000`; valid
  range `100`–`120000`.
- `PRIVACY_SERVICE_MAX_ATTEMPTS`: bounded Team materialization attempts.
  Default `3`; valid range `1`–`5`.
- Transient Privacy Service and Team-safe embedding failures remain durable
  pending work. PostgreSQL notifications wake immediate work, while each
  Worker keeps one exact timer for the earliest persisted retry, claim-expiry,
  or stale-lock deadline. Processing failures use bounded backoff and long
  inference renews its fenced claim; neither path uses an idle polling interval.
- `PRIVACY_MATERIALIZATION_TARGET_LIMIT`: Team targets reconciled per Worker
  pass. Default `25`; valid range `1`–`100`.
- `PRIVACY_MATERIALIZATION_MAX_FRONTIER_BYTES`: maximum source frontier bytes
  admitted to one materialization. Default `67108864`; valid range `1024`–
  `268435456`.
- `PRIVACY_MATERIALIZATION_MAX_RECORDS`: maximum source records admitted to one
  materialization. Default `20000`; valid range `1`–`100000`.
- `PRIVACY_SERVICE_HOST` / `PRIVACY_SERVICE_PORT`: bind address and port for the
  service process. Defaults to `127.0.0.1:8092`.
- `PRIVACY_MAX_FIELDS`, `PRIVACY_MAX_FIELD_BYTES`,
  `PRIVACY_MAX_REQUEST_FIELD_BYTES`, and `PRIVACY_MAX_BODY_BYTES`: the shared,
  versioned Privacy transport contract. Values are fixed at `128`, `262144`,
  `1048576`, and `2097152`; startup rejects deployment overrides that differ.
  Limits measure field count, one field's UTF-8 bytes, all field UTF-8 bytes,
  and the encoded request body respectively. The pinned byte-level tokenizer
  has a `262144`-token outer field guard while model inference remains bounded
  to a 256-token core plus 128 context tokens on either side.
- A semantic preview admits at most 65,536 classification fields, 64 MiB of
  classification text, and 80 MiB for its complete encoded canonical payload.
  Privacy work persists deterministic 16-field cache chunks. Each limit has
  one meaning; these whole-preview limits bound trusted Worker finalization
  memory and do not alter the Privacy request limits.
- Complete semantic-preview reconstruction and publication use one
  deployment-wide PostgreSQL advisory-lock slot. The slot is non-blocking,
  crash-released, and fixed at one. The opt-in maximum-preview capacity test
  (`KOED_RUN_PRIVACY_CAPACITY_TESTS=1`) measures finalization at the full 64 MiB
  classification-text ceiling; the reference Linux/Node run required hundreds
  of MiB of transient heap, so additional concurrent finalizations are not
  admitted without new measured capacity evidence.
- `koed-server models status --kind privacy --json` and `koed-server models
install --kind privacy --json`: verify or install the pinned local Privacy
  Service model, tokenizer, decoder, and calibration assets in Koed's
  content-addressed model cache. Runtime configuration cannot silently select a
  different classifier generation.
- `COLLABORATION_REPLAY_PRUNE_INTERVAL_MS`: Worker interval for pruning expired
  collaboration replay events after advancing a durable scope-bound low-water
  mark. Default `60000`; values below `1000` are clamped.
- `COLLABORATION_REPLAY_PRUNE_BATCH_LIMIT`: maximum expired collaboration
  replay events removed in one transaction. Default `1000`; values above
  `10000` are clamped.
- `EMBEDDING_SERVICE_HOST_PORT`: host port mapped to the Embedding Service dependency container when using the Docker Compose starter. Default `3800`.
- `EMBEDDING_SERVICE_URL`: explicit Embedding Service URL consumed by `koed-server`, API, and Worker in external dependency mode. For the Docker Compose starter, use `http://localhost:${EMBEDDING_SERVICE_HOST_PORT}`.
- `KOED_MODELS_DIR`: optional shared model directory for bundled-local model install and Docker Compose model mounts. Defaults to `KOED_HOME/models`.
- `KOED_EMBEDDING_MODEL_URL` / `KOED_EMBEDDING_MODEL_SHA256`: optional custom artifact URL and expected SHA-256 used by `koed-server models install --kind embedding`. When unset, Koed installs the default pinned Qwen embedding model. Install writes to `KOED_MODELS_DIR`/`KOED_HOME/models` unless `KOED_EMBEDDING_MODEL_PATH` overrides the destination.
- `KOED_RERANKER_MODEL_URL` / `KOED_RERANKER_MODEL_SHA256`: artifact URL and expected SHA-256 used by `koed-server models install --kind reranker`. The SHA-256 is required whenever reranking is enabled; Embedding Service startup hashes the exact GGUF passed to llama-server and rejects a mismatch. Install writes to `KOED_MODELS_DIR`/`KOED_HOME/models` unless `KOED_RERANKER_MODEL_PATH` overrides the destination.
- `KOED_BUNDLED_POSTGRES_MODE`: deprecated. Bundled-local Postgres is native-only; `compose` is ignored and missing native binaries report setup guidance.
- `KOED_POSTGRES_BIN_DIR`: directory containing native `initdb`, `pg_ctl`, `psql`, `pg_dump`, and `pg_restore` binaries for bundled-local Postgres. Defaults to `KOED_HOME/runtime/postgres/bin`, then packaged Desktop resources when running packaged Desktop, with source-checkout `vendor/postgres/bin` only as a development fallback. Individual startup binary overrides are also available with `KOED_POSTGRES_INITDB_BIN`, `KOED_POSTGRES_PG_CTL_BIN`, and `KOED_POSTGRES_PSQL_BIN`; hosted backup commands may use `PSQL_BIN`, `PG_DUMP_BIN`, and `PG_RESTORE_BIN` for external database operators.
- `KOED_POSTGRES_DATA_DIR`, `KOED_POSTGRES_RUN_DIR`, `KOED_POSTGRES_LOG_PATH`: optional native bundled-local Postgres data, socket/runtime, and log paths. Defaults live under `KOED_HOME`.
- `KOED_BUNDLED_EMBEDDING_MODE`: deprecated. Bundled-local Embedding Service is native-only; `compose` is ignored and missing native assets report setup guidance.
- `KOED_EMBEDDING_LLAMA_SERVER_BIN`: llama-server executable for the native bundled-local Embedding Service. Defaults to `KOED_HOME/runtime/llama.cpp/llama-server`, then packaged Desktop resources when running packaged Desktop, with source-checkout `vendor/llama.cpp/llama-server` only as a development fallback; the Docker default `EMBEDDING_LLAMA_SERVER_BINARY=/opt/llama.cpp/llama-server` is ignored for native auto-detection unless overridden with this setting.
- `KOED_EMBEDDING_ACCELERATION`: embedding acceleration policy: `auto`, `cpu`, `metal`, or `cuda`. Native bundled-local runs default to `auto`; CPU Docker Compose defaults to `cpu`. `auto` prefers Metal on Apple Silicon and CUDA on Linux/WSL when the selected llama-server reports a compatible device, then falls back visibly to CPU. Explicit GPU policies fail instead of falling back.
- `KOED_HARDWARE_ACCELERATION`: persisted local inference preference used by Koed Desktop. `auto` enables compatible local acceleration and `cpu` disables it. Service-specific `KOED_EMBEDDING_ACCELERATION` or `PRIVACY_RUNTIME_PROVIDER` environment values remain Operator overrides and make the Desktop control read-only.
- `KOED_EMBEDDING_DEVICE`: optional exact llama-server device identifier, such as `CUDA0`. The device must match the requested backend.
- `KOED_EMBEDDING_GPU_IDLE_UNLOAD_SECONDS`: seconds of accelerator inactivity before llama-server unloads the embedding model from memory. Defaults to `300`; `0` keeps it resident. CPU execution does not use this policy.
- `KOED_RERANKER_ACCELERATION`: independent reranker acceleration policy. Defaults to `cpu` to avoid unexpected VRAM contention with embedding work.
- `KOED_RERANKER_DEVICE`: optional exact llama-server device identifier for the reranker.
- `KOED_RERANKER_GPU_IDLE_UNLOAD_SECONDS`: independent accelerated reranker idle-unload delay. Defaults to `300`; `0` keeps it resident.
- `EMBEDDING_LLAMA_N_CTX`, `EMBEDDING_LLAMA_N_BATCH`, and `EMBEDDING_LLAMA_N_UBATCH`: context, logical batch, and physical microbatch sizes. The defaults are 8192, 8192, and 512. The bounded context and microbatch avoid allocating accelerator buffers for unused 32K context or the entire logical batch while preserving the 4096-token embedding input contract.
- `KOED_PACKAGED_DESKTOP=1`: selects packaged Desktop resolver behavior. Packaged mode does not use source-checkout fallbacks unless `KOED_ALLOW_PACKAGED_SOURCE_FALLBACK=1` is set for developer diagnostics. `status --json` and `doctor --json` include runtime artifact source diagnostics such as `koed-home-runtime`, `packaged-resource`, or `source-checkout`.
- `KOED_EMBEDDING_HOST`, `KOED_EMBEDDING_PORT`: host and port for the native bundled-local Embedding Service. Defaults to `127.0.0.1` and `EMBEDDING_SERVICE_HOST_PORT`/`3800`.
- `KOED_PDS_LAN_PORT`: private-network Desktop pairing and local PDS relay
  gateway port. Defaults to `3310`. Keep it off the public internet; changing
  it is intended for a local port conflict, not as an authentication control.
- `koed-server runtime status --provider homebrew --json`: macOS, Linux, and WSL diagnostic command for Homebrew-backed native runtime assets. It does not install packages or mutate Homebrew state.
- `koed-server runtime install --provider homebrew --dependency-mode bundled-local --json`: explicit macOS, Linux, and WSL install command that may run Homebrew for missing `postgresql@17`, `pgvector`, and `llama.cpp`, links selected binaries under `KOED_HOME/runtime`, and writes metadata under `KOED_HOME/cache`.
- `koed-server` writes Desktop's app-provisioned local credential under `KOED_HOME/config/local-app-credential.json` without exposing the API Token in status output.
- `WORKER_NODE_ENV`: runtime environment for the worker service.
- `MEMORY_RAW_PROJECTION_BATCH_LIMIT`: maximum raw rows projected per actor on each worker catch-up pass. Default `1000`.
- `MEMORY_RAW_PROJECTION_ACTOR_LIMIT`: maximum memory owner scopes checked on each worker catch-up pass. Default `10`.
- `MEMORY_HISTORICAL_IMPORT_BATCH_ROWS`: hard maximum raw rows selected for one historical Projection batch. An atomic segment larger than this cap remains pending until the Operator raises the cap. Default `100`; valid range `1`–`1000`.
- `MEMORY_HISTORICAL_IMPORT_BATCH_BYTES`: hard maximum raw payload bytes selected for one historical Projection batch. An atomic segment larger than this cap remains pending until the Operator raises the cap. Default `1000000`; valid range `1`–`10000000`.
- `MEMORY_HISTORICAL_IMPORT_BATCH_RUNTIME_MS`: maximum historical Projection runtime before yielding at next Projection boundary. Default `15000`; valid range `100`–`60000`.
- `MEMORY_HISTORICAL_IMPORT_CONCURRENCY`: historical Projection worker slots. Must remain `1`; values outside `1`–`1` fail configuration validation.
- `MEMORY_HISTORICAL_IMPORT_LIVE_BACKLOG_MAX`: live raw-Projection rows permitted before historical admission pauses. Default `0`; valid range `0`–`10000`.
- `MEMORY_HISTORICAL_IMPORT_API_READY_URL`: optional worker-visible API readiness override for historical admission. When omitted, Koed derives `/ready` from `MEMORY_API_URL`; if neither URL is configured, historical batches fail closed.
- `MEMORY_HISTORICAL_IMPORT_API_READY_TIMEOUT_MS`: timeout for that API readiness probe. Default `1000`; valid range `100`–`10000`.
- `MEMORY_HISTORICAL_IMPORT_ENABLED`: set to `false` to disable automatic
  historical ingestion in the supervised Local AI Runtime. Independent
  provider-neutral coordinators run for each enabled supported AI Client
  (Codex, Claude Code, and Pi); one client's discovery or retry state does not
  block another. Candidate discovery retries transient failures before freezing
  a cohort. Raw production is nevertheless serialized by one shared runtime
  lease so separate providers cannot pass advisory admission concurrently.
- `MEMORY_HISTORICAL_IMPORT_SOURCE_BATCH_ROWS`: maximum canonical raw items in
  one Local AI Runtime historical upload. Default `100`; valid range `1`–`500`.
- `MEMORY_HISTORICAL_IMPORT_SOURCE_BATCH_BYTES`: maximum serialized canonical
  raw-item bytes in one Local AI Runtime historical upload. Default `1000000`;
  valid range `1024`–`3800000`.
- `MEMORY_HISTORICAL_IMPORT_SOURCE_BATCH_RUNTIME_MS`: maximum parser runtime
  before the Local AI Runtime yields at a complete record. Default `15000`;
  valid range `100`–`60000`.
- `MEMORY_HISTORICAL_IMPORT_JOURNAL_BATCH_BYTES`: target complete source bytes
  appended to the Conversation Source Journal in one coordinator pass across
  every supported AI Client. One complete source record may exceed the target
  up to the source-record ceiling. Default `1048576`; valid range
  `1024`–`4194304`.
- `MEMORY_VECTOR_CANDIDATE_LIMIT`: vector retrieval candidate count.
- `MEMORY_RAG_ROLLUP_CANDIDATE_LIMIT`, `MEMORY_RAG_LEAF_CANDIDATE_LIMIT`, `MEMORY_RAG_FRESH_EVENT_CANDIDATE_LIMIT`, `MEMORY_RAG_RAW_FALLBACK_CANDIDATE_LIMIT`, `MEMORY_RAG_SCOPED_LEAF_CANDIDATE_LIMIT`: optional per-stage retrieval candidate limits. Leave blank to use code defaults derived from the requested result limit.
- `MEMORY_RAG_ROLLUP_RESULT_LIMIT`: optional cap on rollup results admitted into final recall evidence.
- `MEMORY_RAG_RAW_FALLBACK_ENABLED`: set `false` to disable raw fallback retrieval.
- Production recall uses semantic candidate generation plus narrowed exact
  checks. BM25 and lexical baselines exist only in the Retrieval Arena.
- `MEMORY_RAG_ROLLUP_MIN_SCORE`, `MEMORY_RAG_SCOPED_LEAF_MIN_SCORE`, `MEMORY_RAG_LEAF_MIN_SCORE`, `MEMORY_RAG_FRESH_EVENT_MIN_SCORE`, `MEMORY_RAG_RAW_FALLBACK_MIN_SCORE`: optional per-stage minimum score thresholds. Leave blank to use the default threshold of `0`.
- `MEMORY_EVENT_MAX_TOKENS`: soft token target for projected semantic Memory Event bundle rollover. Default `2048`; values above `32768` are clamped to the Qwen operational cap. Projection rolls over only between complete source items at this target.
- `MEMORY_AGENT_TURN_STALE_MS`: quiet-time fallback for sealing an incomplete agent-turn Memory Event during catch-up if no turn-complete Capture Hook or next user prompt arrives. Default `900000` (15 minutes). Set `0` only in tests or controlled recovery runs to seal any incomplete agent turn immediately.
- `SEMANTIC_MEMORY_REBUILD_DEBOUNCE_MS`: debounce before rebuilding and re-embedding semantic Memory Events after a display item is deleted. Default `300000` (5 minutes). Set `0` only in tests or controlled repair runs.
- `MEMORY_LCM_LEAF_EVENT_THRESHOLD`: event count threshold for creating LCM placeholders. Default `100`.
- `MEMORY_LCM_LEAF_TOKEN_THRESHOLD`: semantic `memory_event.content` token threshold for creating LCM placeholders. Default `32768`; values above `32768` are clamped to the Qwen operational cap. Provenance payload JSON is not counted.
- `MEMORY_LCM_FRESH_EVENT_TAIL`: recent event tail excluded from LCM placeholder creation. Default `10`.
- `MEMORY_LCM_COMPACTION_MAX_EVENTS`: maximum eligible Memory Events admitted to one owner-scoped LCM compaction reconciliation batch. Default `1000`; maximum `10000`.
- `MEMORY_LCM_DEPTH1_FANOUT`: leaf fanout for depth-1 LCM placeholder creation. Default `20`.
- `EMBEDDING_MODEL_KEY`: supported embedding model key. The embedding service maps this key to an internal supported model definition and fails startup for unknown keys. Default and currently supported key: `qwen3-0.6b`.
- `EMBEDDING_RERANKER_KEY`: supported reranker model key. Leave blank to disable reranking. Currently supported key: `qwen3-reranker-0.6b`. Docker Compose maps this root setting to each app's process-local `RERANKER_KEY`; direct app-local runs may set `RERANKER_KEY` explicitly, with the app-local value taking precedence.
- `EMBEDDING_SERVICE_TOKEN`: shared internal token required by embedding and reranking endpoints when configured. `pnpm env:setup` generates this for Docker Compose deployments.

The CUDA Docker starter is an explicit override and requires a working NVIDIA
Container Toolkit:

```bash
docker compose \
  -f examples/docker-compose/docker-compose.yml \
  -f examples/docker-compose/docker-compose.cuda.yml \
  up --build
```

Use the equivalent two files under `examples/server-compose` for a server
deployment. The CUDA image is pinned by digest and forced to `cuda`; a missing
container GPU therefore fails visibly. Do not set a backend-class label: Koed
derives the capacity backend from the supervised process.

The redistributable native Linux CUDA payload is built with pinned CUDA Toolkit
12.4 and requires NVIDIA Linux driver 550.54.14 or newer. Runtime compatibility
is still established by the packaged launcher and `llama-server --list-devices`;
the version floor alone never asserts that a device is usable.
Generated CUDA binaries are not committed to Git. The optional Linux native CI
job and trusted default-branch cache workflow build on GitHub-hosted Ubuntu
22.04 only when the content-addressed pinned recipe is missing. Releases consume
the validated cache and publish a versioned archive, SHA-256 sidecar, and
provenance manifest; ordinary CI and local setup do not compile CUDA.

- `EMBEDDING_SERVICE_HEALTH_TIMEOUT_MS`: timeout for API/worker embedding service health probes used by status and access-check routes. Default `1000`.
- `EMBEDDING_QUERY_INSTRUCTION_ENABLED`: whether semantic recall query embeddings use the Qwen-style `Instruct: ...\nQuery: ...` wrapper. Default `true` for Qwen3 embedding models. Set `false` to compare retrieval or benchmark behavior without query instructions. Stored Memory Event, Memory Node, message, and other source embeddings are not prefixed.
- `EMBEDDING_QUERY_INSTRUCTION`: optional instruction text for semantic recall query embeddings. Leave blank to use the Koed default instruction for retrieving relevant Memory Events, conversation items, and summaries.
- `EMBEDDING_LOG_LEVEL`: embedding service structured JSON log level. Default `info`; use `debug` for scheduler, chunking, batching, and reranker scoring details.
- `EMBEDDING_BATCH_LIMIT`: embedding service batch limit.
- `EMBEDDING_REQUEST_TIMEOUT_MS`: maximum time the Worker allows an internal
  embedding request to run. Long LCM sources are submitted individually and
  retain their queue lease while this bounded request is active.
- `EMBEDDING_CAPACITY_REFINED_DELAY_MS`: delay after Worker startup before the
  longer refined capacity calibration runs. Default `1800000` (30 minutes);
  accepted values range from `1000` to `86400000` milliseconds.
- `KOED_EMBEDDING_POOL_KEY`: stable infrastructure identity for one equivalent
  embedding worker pool. Different CPU, Metal, CUDA, model, or execution pools
  must use different bounded keys so their profiles coexist. Default `default`
  for a single local pool.
- `EMBEDDING_MAX_TOKENS`: Koed adapter chunking limit and the hard cap for a single projected source item before forced split metadata is used. Default `4096`; values above `32768` are clamped by the embedding service and values above the configured llama context or batch envelope are reduced to that limit.
- `EMBEDDING_MAX_TEXT_CHARS`: transport and abuse guard for the maximum characters accepted for any single embedding or reranking text before model processing. The Worker divides a larger logical source into bounded transport segments without splitting Unicode characters, then restores one continuous source-level embedding chunk sequence from the responses. It is not a semantic chunking limit.
- `EMBEDDING_MAX_REQUEST_CHARS`: transport and abuse guard for the maximum total characters the Worker sends, and the Embedding Service accepts, in one embedding or reranking request before model processing. It is not a semantic chunking limit.
- `EMBEDDING_LLAMA_N_CTX`: llama.cpp context size for the embedding service. Default `8192`; values above `32768` are clamped by the embedding service. The default leaves headroom above the 4096-token embedding input limit without reserving an unused 32K accelerator context.
- `EMBEDDING_LLAMA_N_BATCH`: llama-server logical execution batch capacity. This is a runtime throughput and capacity knob, not Koed's semantic chunk size; keep it large enough for `EMBEDDING_MAX_TOKENS` plus batching/headroom.
- `EMBEDDING_LLAMA_N_UBATCH`: llama-server physical microbatch capacity. Current llama.cpp embedding servers reduce the effective logical batch to this value when it is lower than `EMBEDDING_LLAMA_N_BATCH`, so Koed uses the smaller capacity for chunking and batching. Default `512`.
- `EMBEDDING_LLAMA_BATCH_TOKEN_HEADROOM`: token safety margin subtracted from `EMBEDDING_LLAMA_N_BATCH` when chunking and batching embedding texts. Default `8`; this avoids tokenizer boundary cases where a nominal 8192-token text becomes 8193 tokens at model execution time.
- `EMBEDDING_RERANKER_BATCH_LIMIT`: reranker batch limit.
- `EMBEDDING_RERANKER_CONTEXT_PER_SLOT`: reranker context budget per llama-server parallel slot. This is separate from embedding context because Qwen reranking scores query-document classifier prompts, not embedding chunks.
- `EMBEDDING_RERANKER_LLAMA_N_CTX`: optional total reranker llama-server context override. Leave blank to derive it from `EMBEDDING_RERANKER_CONTEXT_PER_SLOT * EMBEDDING_RERANKER_PARALLEL`.
- `EMBEDDING_RERANKER_LLAMA_N_THREADS`: optional reranker thread override. Leave blank to use the embedding service thread default.
- `EMBEDDING_RERANKER_LLAMA_N_BATCH`: reranker logical batch size. It must cover the largest formatted query-document prompt you intend to score.
- `EMBEDDING_RERANKER_LLAMA_N_UBATCH`: reranker physical microbatch size. Tune this for CPU performance and memory, but keep it large enough for the largest formatted query-document prompt; llama-server rejects oversized rerank pairs.
- `EMBEDDING_RERANKER_PARALLEL`: reranker llama-server parallel slot count.
- `EMBEDDING_RERANKER_PROMPT_CACHE_ENABLED`: enables llama-server prompt caching for reranking. Default `true`; benchmark both modes explicitly because same-query rerank requests can reuse the shared instruction/query prefix.

## Transcript Watcher Values

`koed-server` passes these local values to the provider Transcript Watchers
hosted by its supervised Local AI Runtime:

- `CODEX_HOME`: Codex state root. Transcript Watcher defaults to its `sessions` directory, or `~/.codex/sessions` when unset.
- `MEMORY_CODEX_TRANSCRIPT_ROOTS`: optional platform path-delimited list of explicit transcript roots. When non-empty, replaces the `CODEX_HOME/sessions` default; it never broadens scanning to arbitrary home directories.
- `MEMORY_CODEX_TRANSCRIPT_WATCHER_ENABLED`: watcher supervisor switch. Default `true` for developer/local-personal runtime modes. External runtime mode cannot enable the watcher; capture must run through a local-personal `koed-server`.
- `MEMORY_CLAUDE_TRANSCRIPT_WATCHER_ENABLED`: Claude watcher switch with the same runtime-mode boundary. Claude capture uses private Hook signals and provider source files under the configured Claude home rather than Codex transcript roots.
- `PI_CODING_AGENT_DIR`: custom Pi profile home. Koed preserves profile boundary for package setup, model authentication, and default session discovery.
- `PI_CODING_AGENT_SESSION_DIR`: explicit Pi persistent session root.
- `MEMORY_PI_TRANSCRIPT_WATCHER_ENABLED`: Pi watcher switch. Pi capture uses content-free extension signals plus periodic persistent-session filesystem discovery.
- `MEMORY_PI_TRANSCRIPT_MAX_BYTES_PER_BATCH`: maximum complete Pi JSONL bytes journaled and consumed per bounded page. Default `4194304`; minimum `1024`; maximum `16777216`.
- `MEMORY_CODEX_TRANSCRIPT_DEBOUNCE_MS`: coalescing delay for filesystem notifications and Capture Hook wake signals. Default `200`.
- `MEMORY_CODEX_TRANSCRIPT_MAX_ENTRIES_PER_SCAN`: maximum filesystem entries inspected per scan. Default `4000`.
- `MEMORY_CODEX_TRANSCRIPT_MAX_FILES_PER_SCAN`: maximum transcript files processed per scan. Default `200`.
- `MEMORY_CODEX_TRANSCRIPT_MAX_BYTES_PER_BATCH`: maximum sequential transcript bytes parsed per watcher page. Default `1048576`.

## AI Client Values

These values are copied into the AI Client configuration and are not consumed automatically by Docker Compose:

- `KOED_PROMPT_DIR`: optional directory containing Markdown prompt overrides
  for local/self-hosted Koed prompt surfaces. Override files must mirror the
  bundled root `prompts/` layout and keep matching frontmatter ids. A configured
  override directory must exist and be readable; individual files omitted from
  a valid directory fall back to bundled defaults. Malformed prompt files,
  wrong ids, empty files, missing required runtime placeholders, or unresolved
  template placeholders fail loudly. Prompt overrides can adjust wording and
  add optional content, but code still owns required placeholders, JSON schemas,
  parser validation, source serialization, authorization, redaction, and
  retrieval boundaries. LCM overrides must declare
  `output_schema: lcm-semantic-summary-v1` in frontmatter and produce that
  contract. The LCM Summary Service validates all four LCM prompt contracts
  before listing pending work or calling Codex. Overrides copied from an earlier
  build that produce `lcm-structured-summary-v1` output must be updated or
  removed; incompatible overrides fail with an actionable error. MCP builds
  carry the bundled defaults inside the deployed runtime. `pnpm codex:bootstrap` resolves relative override paths
  against the Koed checkout and writes an absolute directory into the persistent
  MCP environment, so opening Codex from a different Project does not change
  which prompts are loaded. LCM summaries, Memory Answer, and generated session
  titles persist the frontmatter version of the prompt that produced them.

- `MEMORY_API_URL`: API URL used internally by the `koed-server`-supervised Local AI Runtime. The MCP adapter and Supported Capture Hook do not receive it through MCP configuration.
- `KOED_EVAL_NO_LEXICAL_INDEX_MANIFEST` and
  `KOED_EVAL_NO_LEXICAL_INDEX_PROOF_SHA256`: Retrieval Arena-only settings for
  a separate no-anchor runtime. Both must be set together; the proof value is
  the SHA-256 of the exact local manifest bytes. The API validates the manifest
  against `MEMORY_API_URL`, the effective embedding model, and each document's
  summary-only input, generation, source hash, and vector checksum in the exact
  live isolated database/schema and document set before advertising the
  isolated-index capability. Leave both unset for normal production retrieval. The older
  `KOED_EVAL_RETRIEVAL_COMPOSITION` string is not trusted as a capability.
- `MEMORY_API_TOKEN`: User-owned Personal API Token provisioned for a supervised
  Local AI Runtime. `developer` and `local-personal` runtime modes require it
  before starting that runtime. `external` mode does not supervise a Local AI
  Runtime and does not require or receive this setting. The token does not grant
  Team administration; Team authority comes from verified identity, Team
  Membership, and roles. Operators can inspect and revoke local token records
  with `pnpm api-token:list` and `pnpm api-token:revoke`; it is not written into
  MCP configuration.
  When Hosted Personal Source Replication is explicitly enabled, the Worker
  uses this local API bridge to request an owner-bound encrypted embedding
  artifact from the enrolled upstream before local inference. Missing local
  bridge configuration fails closed; it does not silently spend local compute
  or create a second vector. When no hosted policy is active, one capable PDS
  device obtains the exact relay claim before embedding synchronized source.
  `getPdsLocalSyncStatus` and operator diagnostics expose only aggregate
  authority, lease, intent, and accepted-artifact counts.
- `MEMORY_RAW_INGEST_BATCH_BYTES`: target maximum request size for canonical conversation-item ingestion batches. Default `180000`. Oversized logical items use at most 64 transport chunks of 256 KiB each and fail before upload above the 16 MiB logical-item ceiling.
- `MEMORY_API_REQUEST_TIMEOUT_MS`: timeout for Local AI Runtime API calls. Default `60_000`.
- `KOED_AI_CLIENT_INSTANCE_REGISTRY`: explicit JSON registry of local AI Client instances probed by the Local AI Runtime. Default `KOED_HOME/config/ai-client-instances.json`; missing or empty registry publishes no instances. Setup commands register provider defaults.
- `MEMORY_EXPOSE_DIAGNOSTIC_MEMORY_TOOLS`: when `true`, exposes diagnostic MCP tools such as `memory_access_check`. Default `false`; use the MCP `doctor` CLI command for normal setup checks.
- `MEMORY_EXPOSE_LOW_LEVEL_MEMORY_TOOLS`: when `true`, exposes low-level diagnostic MCP retrieval tools such as `memory_search` and `memory_expand`. Default `false`; normal recall should use `memory_answer`.
- `MEMORY_CODEX_APP_SERVER_BINARY`: explicit Codex executable override for nonstandard installations. When unset or blank, Koed searches `PATH` and, on macOS, `~/.local/bin`, `/opt/homebrew/bin`, and `/usr/local/bin`.
- `KOED_CLAUDE_CODE_EXECUTABLE`: optional absolute path to a separately installed Claude Code executable. When unset or blank, Koed searches `PATH` and, on macOS, `~/.local/bin`, `/opt/homebrew/bin`, and `/usr/local/bin`. Koed validates the local installation; it never accepts an Anthropic API key or bundles Claude Code.
- `KOED_PI_EXECUTABLE`: optional absolute path to separately installed Pi `0.84.2+`. When unset or blank, Koed searches `PATH` and, on macOS, `~/.local/bin`, `/opt/homebrew/bin`, and `/usr/local/bin`. Koed canonicalizes and validates the installation, resolves Windows npm shims to a verified Node entry point, and reuses Pi-managed authentication; it never accepts Pi provider credentials or bundles Pi.
- `KOED_CLAUDE_CODE_DISCOVERY_CACHE`: optional absolute local path for the owner-only confirmed installation record. Default `KOED_HOME/state/claude-code-installation.json`.
- `KOED_MANAGED_CONVERSATION_CLAUDE_MODEL`: model used for Koed-managed Claude Conversations. Default `claude-haiku-4-5-20251001`.
- `MEMORY_ANSWER_PROVIDER`: AI Client provider for MCP Memory Answer synthesis. Supported values are `codex`, `claude`, and `pi`; default `codex`. Pi requires full provider/model ID.
- `MEMORY_ANSWER_AI_CLIENT_INSTANCE`: selected local AI Client instance. Default `<provider>.default`.
- `MEMORY_ANSWER_MODEL`: provider model for MCP Memory Answer synthesis. The Codex default is `gpt-5.6-luna`; Claude uses `haiku` when unset, and Pi requires an explicit full provider/model ID.
- `MEMORY_ANSWER_REASONING_EFFORT`: provider-supported reasoning effort. Default `low`.
- `MEMORY_ANSWER_TIMEOUT_MS`: timeout for each local MCP Memory Answer app-server turn.
- `MEMORY_ANSWER_MAX_ATTEMPTS`: maximum local MCP Memory Answer synthesis attempts.
- `MEMORY_ANSWER_MAX_SEARCHES`: maximum Koed RAG search tool calls per MCP Memory Answer worker turn.
- `MEMORY_ANSWER_MAX_EXPANSIONS`: maximum Koed RAG evidence expansion tool calls per MCP Memory Answer worker turn.
- `MEMORY_ANSWER_MAX_CANDIDATES`: maximum internal candidates retained by one Memory Answer. Default `50`; valid range `1`–`200`.
- `MEMORY_ANSWER_MAX_EVIDENCE_ITEMS`: maximum evidence items admitted to one Memory Answer prompt. Default `50`; valid range `1`–`200`.
- `MEMORY_ANSWER_MAX_EVIDENCE_TOKENS`: maximum estimated evidence tokens admitted to one Memory Answer prompt. Default `12000`; valid range `256`–`100000`.
- `MEMORY_ANSWER_MAX_PROMPT_TOKENS`: maximum estimated complete Memory Answer prompt tokens. Default `24000`; valid range `512`–`200000`.
- `MEMORY_LCM_SUMMARY_PROVIDER`: AI Client provider for LCM Summary and session-title synthesis. Supported values are `codex`, `claude`, and `pi`; default `codex`. Pi requires full provider/model ID.
- `MEMORY_LCM_SUMMARY_AI_CLIENT_INSTANCE`: selected local AI Client instance. Default `<provider>.default`.
- `MEMORY_LCM_SUMMARY_MODEL`: provider model for LCM Summary synthesis. The Codex default is `gpt-5.6-luna`; Claude uses `haiku` when unset, and Pi requires an explicit full provider/model ID.
- `MEMORY_LCM_SUMMARY_REASONING_EFFORT`: provider-supported reasoning effort. Default `low`.
- `MEMORY_LCM_SUMMARY_TIMEOUT_MS`: timeout for each local LCM Summary app-server turn.
- `MEMORY_LCM_SUMMARY_MAX_ATTEMPTS`: maximum local LCM Summary synthesis attempts.
- `MEMORY_LCM_SUMMARY_RETRY_DELAY_MS`: delay between local LCM Summary retry attempts.
- `MEMORY_LCM_SUMMARY_CONCURRENCY`: maximum concurrent local LCM Summary workers.
- `MEMORY_LCM_SUMMARY_MAX_PROMPT_TOKENS`: maximum prompt budget for selected local AI Client LCM Summary calls. Default `48000`.
- `MEMORY_LCM_BACKGROUND_INITIAL_DELAY_MS`: delay before the Local AI Runtime first checks for pending work.
- `MEMORY_LCM_BACKGROUND_PUSH_DELAY_MS`: delay used when the local service is nudged after capture.
- `MEMORY_LCM_BACKGROUND_INTERVAL_MS`: periodic background check interval for pending summaries.
- `MEMORY_LCM_BACKGROUND_BATCH_LIMIT`: maximum pending LCM summaries processed in one background batch.
- `MEMORY_SESSION_TITLE_BACKGROUND_BATCH_LIMIT`: maximum pending captured-session titles processed in one local memory processing batch.
- `MEMORY_SESSION_TITLE_MIN_USER_EVENTS`: minimum user events before a captured session is eligible for local generated title processing. Default `3`.

`koed-server` supervises one Local AI Runtime after its startup readiness check
and local API Token resolution, and stops it before the API. The runtime owns
Codex, Claude, and Pi Transcript Watchers, LCM Summary Service, Curated Memory review, and fresh
Memory Answer workers. If the API is still recovering, bounded watcher rescans
keep retrying. Configure each supported AI Client to run its Supported Capture Hook for
`SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`, `SubagentStart`, and
`SubagentStop`. The Hook supplies a low-latency content-free wake hint; Stop
events also record a timestamped boundary under hashed source-routing identities
so the matching transcript frontier can release a page-ending fallback
assistant record. Missing signals may delay that fallback but cannot create a
permanent gap; repeated signals do not duplicate capture. The watcher discovers
parent and child transcripts independently and preserves their provider
identities and linkage from journaled JSONL.

Koed relies on the connected AI Client for Synthesis; backend LLM provider configuration and server-side synthesis are unsupported in this build.
The Local AI Runtime is enabled by default in this build. It generates
captured-session titles and LCM summaries through the selected local AI Client.
Failures are reported as diagnostics and pending summaries remain searchable as
degraded evidence. The API stores per-user Memory Answer, LCM Summary, session-title, and Curated Memory Review assignments independently; the Local AI Runtime reads them at execution time. `.env` values are bootstrap defaults only; precedence is API user setting, then `.env`, then code default. Desktop Advanced settings exposes only `mcp_memory_answer` (Memory Answer), `lcm_summary`, `session_title`, and `curated_memory_review`; `manual_memory_answer` is not a supported selector. Reset deletes one selected assignment and never changes other flows.

LCM summary prompt-version changes are forward-only. Existing completed
summaries are not automatically regenerated; new prompts apply to new or
naturally invalidated LCM nodes.

If the selected AI Client cannot be started or authenticated, local Synthesis
fails visibly instead of switching provider or falling back to a backend LLM
path.

Capture Policy state `ask` currently blocks automatic capture. It is reserved
for a future AI-client approval flow and is not an implemented backend prompt.

Projection selection is configured through the DB-backed
`projection_policy_rules` table, not `.env`. These rows define which Codex
transcript item types are projected into Desktop, semantic Memory
Events, embeddings, and LCM sources. The seeded defaults keep UI projection and
embedding selection matched for every transcript type in the current build, but
the fields are independent so future policy rows can support display-only or
recall-only transcript types without a schema change.

## Historical Import Scheduling

Work classes have fixed priorities across Postgres `local_work_queue` and
BullMQ: interactive Recall/Memory Questions (`1`), live Capture Projection
(`5`), normal embedding/LCM (`10`), and historical import/backfill (`20`).
Lower number runs first. Queue payloads contain identifiers and class only;
they never contain source content or local paths. Historical backlog is shown
only as redacted diagnostic counters in authenticated `/ops/status`; it is not
part of `/ready` and does not make Koed unavailable.

FIFO is currently only the within-class tie-breaker. These fixed classes and
bounded historical admission do not yet provide aging, token-cost fairness,
per-User/tenant shares, reserved interactive capacity, or dynamic dispatch
priority; KOE-355 owns that scheduler work.

A provider-neutral Local AI Runtime coordinator reuses the Transcript Watcher's
bounded discovery and current Project metadata. It selects by latest activity
inside the fixed 30-day window, caps the cohort at 50, processes selected
sources chronologically, and registers each with immutable fingerprint,
source-session identity, complete-record frontier offset, and bounded prefix sentinel hash.
Pre-frontier rows receive the historical class. Post-frontier rows, including
downtime catch-up, receive the live class. A source created after registration
has a zero frontier and is live from its first complete record. Never label
history from FIFO position, timestamp age, source path, or arbitrary metadata.

Historical import control/status routes are enabled only when
`KOED_DEPLOYMENT_PROFILE` resolves to `developer` or `local_personal`. They
accept owning User browser sessions or Personal API Tokens and grant no Team
authority. No separate configuration enables these routes on private VPS, Team
Self-Hosted, or Koed-managed cloud profiles.

The coordinator retains source paths only in transient local discovery state;
its restart-safe selection and source lookup use Conversation Source Artifact
identity.
Status and batch responses expose a redacted basename label and stable SHA-256
fingerprint, never raw path or path-like detected Project fields. A coordinator
must use the source Artifact's registered AI-client adapter version (the current
automatic adapter is `codex-transcript-v1`) and maintain its bounded historical
parser checkpoint/imported ranges separately from the live-tail/recovery cursor.
Neither stream may derive from or update the other. Source growth is allowed;
truncation, rotation/sentinel-covered prefix mutation, and stale checkpoints fail
explicitly. Exact retries return a read-only replay. Effective Capture Policy and
Capture Pause are rechecked under the same owner-scoped transaction lock as each
batch write.

## Data At Rest

Postgres is the source of truth for Users, API Tokens, Capture Policies, raw
`conversation_items`, messages, tool events, Memory Events, Memory Nodes,
embeddings, LCM placeholders, LCM summaries, Memory Questions, and related
evidence. The application hashes API Tokens with `API_TOKEN_PEPPER`. Local
personal developer deployments store operational Memory rows as normal database
rows. Team Self-Hosted, private VPS, and Koed-managed cloud profiles store new
raw conversation-item source fields, projected message/tool payloads, Memory
Event payloads, Memory Node text/source/structured-summary fields, embedding
source text, and Memory Question query/answer/evidence/worker payloads through
encrypted field companions and keep the operational source columns redacted.
Memory Question sensitive fields are the exception to the profile distinction:
their query, answer, error, evidence, citation, retrieval, worker, and response
payloads always use redacted operational columns plus encrypted companions in
every profile. History listing supports metadata filters and pagination only;
it never performs a broad decrypted text scan.
The encrypted retrieval payload includes caller retrieval hints and the bounded
internal retrieval trace; neither belongs in ordinary logs or diagnostics.
Paid Koed-managed cloud must use a KMS-backed envelope provider. Projection
hydrates raw conversation-item companions inside the trusted repository boundary
before deriving semantic rows. Authorized graph, embedding, retrieval, LCM, and
Memory Question paths hydrate encrypted companions after access checks.
Owner-private remote replicas use the separate
`OWNER_PRIVATE_REPLICA_*` envelope provider family. Team/general encryption
keys are not used as a fallback for owner-private replica reads or writes.

Exact Personal Conversation Source and Personal derived artifacts remain
unchanged and owner-only. Team-readable source, Memory Events, LCM summaries,
lexical anchors, Curated Memory, evidence, and embedding inputs are separately
sanitized and encrypted. The effective eight-label content policy is persisted,
versioned, and hashed; environment values may seed deployment defaults but do
not reinterpret existing Team representations. Encrypted classification
results, sanitized artifacts, Team vectors, and their wrapped keys participate
in retention, hard purge, backup expiry, and encryption rewrap.

Operators should treat the Postgres database and backups as sensitive memory data. Keep Postgres on a private network, restrict database credentials to Koed services and trusted administrators, use encrypted disks or managed-database storage encryption, encrypt backups, and rotate secrets if a backup or database role is exposed.
