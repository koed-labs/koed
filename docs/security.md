# Security

For responsible disclosure, supported versions, and vulnerability reporting,
see [../SECURITY.md](../SECURITY.md). Do not disclose captured Memory data,
database exports, backups, API Tokens, cookies, or private deployment secrets in
public reports.

Koed uses local operator token bootstrap for AI-client access. `pnpm api-token:create` creates a passwordless local owner user when needed, creates a bearer API token for that user, stores only the token hash and prefix, and prints the full token once.

Operators list and revoke local tokens with `pnpm api-token:list` and `pnpm api-token:revoke`. Browser session registration is disabled by default in deployed environments; use local operator scripts from the deployment checkout instead.

AI-client integrations use bearer API tokens. Store generated API tokens immediately; only token prefixes are listed later.

Do not expose Postgres, Redis, or the Embedding Service publicly. Server and
private VPS installs should expose only the intended browser/API-facing
`koed-server` surface through a reverse proxy with TLS. The Docker Compose
starter is for local source-checkout dependencies or an Operator-chosen
container layout; do not run it on a public host without binding dependency
ports to localhost or restricting them with a firewall.

Public health probes are intentionally coarse. `/health` and `/ready` do not expose local paths, model details, dependency exception messages, or secret values.

Diagnostics are redacted by design: they report whether secrets are configured, but not their values. Detailed diagnostic endpoints are not intended for public reverse-proxy exposure.

The Embedding Service is an internal backend component. Keep it off public
networks. Docker Compose passes `EMBEDDING_SERVICE_TOKEN` to the Embedding
Service, API, and Worker so embedding and reranking requests require a shared
internal header.

## Data At Rest

Postgres is the source of truth for memory data. API Tokens are hashed before
storage. Local personal, private VPS, and Team Self-Hosted deployments still
store operational Memory rows as normal database rows unless application-layer
encryption is explicitly configured.

Paid Koed-managed cloud must run with a KMS-backed envelope provider. New
raw `conversation_items` source payloads, projected message/tool payloads,
Memory Event payloads, Memory Node text/source/structured-summary fields, and
embedding source text in that mode store redacted operational payloads and keep
the full human-readable content in encrypted field companions. Stored Memory
Question query, answer, evidence, citation, retrieval, local memory-worker,
response, and error payloads use the same redacted-row/encrypted-companion
pattern. Projection hydrates raw conversation-item companions inside the
trusted repository boundary before deriving semantic rows. Authorized graph,
embedding, retrieval, LCM, and Memory Question paths decrypt companions only
after repository-level visibility checks. Managed/encrypted memory exports and
sync/offload packages use the shared encrypted package envelope so the manifest
is redacted and raw payload bytes remain encrypted. Future support bundles and
object payloads must use the same package envelope before they can carry raw
customer content.

Cross-Identity Sync encrypts each bounded package chunk to the target
deployment's versioned RSA-OAEP recipient key in addition to transport TLS. The
target recipient private key is itself wrapped by the configured root envelope
provider. The source, browser, MCP Server, Capture Hook, database, queue rows,
logs, and diagnostics never receive a plaintext DEK or target private key. The
target authenticates the scoped `sync` device credential and binds deployment,
User, relationship, replica, consent, policy, cursor, version, size, and digest
metadata before decrypting. A missing key, wrong version, provider outage,
tampered envelope, unauthorized target, or unsupported package fails closed.
After package verification, synchronized `conversation_items` keep raw JSON,
raw text, transport text, and full metadata in owner-private encrypted field
companions. Their operational columns contain only encryption markers and the
bounded metadata required for rendering and lifecycle processing. Subsequent
sync reads hydrate those companions inside the repository boundary before
constructing another package, so redaction does not reduce replica fidelity.
Synchronized target session rows retain only operational replica markers;
source conversation titles and external session labels are not copied into
plaintext structural storage.

PDS control plane and relay are not implemented by RSA envelope path. Relay uses
certificate-bound, domain-separated Ed25519 request proofs and stores canonical
encrypted transport/envelope/chunk bytes plus opaque delivery metadata only.
It never decrypts, projects, embeds, recalls, logs plaintext, source
fingerprints, Project aliases, keys, credentials, or Team fields. Authority
secret signer is deployment-secret material; Authority never stores PDS
plaintext, group secrets, device/recovery private keys, or recovery kit
material. Headless controls use an opaque Operator secret reference and
provider stdin/stdout boundary; raw PDS environment values, CLI password
arguments, config values, status, and logs are rejected. Desktop IPC never
carries private keys or recovery-kit bytes. Browser session binds governance
requester identity but cannot replace active-device/recovery authorization. A
scoped `Koed-Desktop` credential may access the same PDS governance routes only
on the `local_personal` loopback boundary for its recorded owner. API Tokens and
`Koed-Device` authentication remain rejected.

For a local-only topology, Desktop may co-locate the neutral Authority service
role with its local API. Its Ed25519 key is a separate opaque,
platform-protected secret resolved only by the trusted API child; it is not the
device member key and is never embedded in the device runtime payload. WSL
DPAPI references are profile-namespaced because multiple isolated Desktop
profiles share one Windows-host credential store.

Same-network Desktop enrollment never sends its invitation secret as an HTTP
credential. The secret remains in the URL fragment and derives an
HKDF-SHA-256/AES-256-GCM transport key. Pairing messages bind direction,
invitation ID, and unique message ID, reject replay, and expose only exact
enrollment control routes. The active device's existing PDS signature remains
required for membership. See
[ADR 0019](adr/0019-same-network-personal-device-enrollment.md).

Existing directed-sync RSA code must not be represented as PDS compliance. PDS
deletion floors are opaque group-lifetime records. Authority retains opaque
logical-memory/floor tokens and encrypted signed tombstone records, not source
plaintext or a source-fingerprint mapping. Normal relay ACK cleanup never
removes a floor. A revoked device receives no new key bundle or package but
cannot be remotely stripped of plaintext it already had.

Use deployment controls for data-at-rest protection: private database networking, least-privilege database credentials, encrypted volumes or managed-database storage encryption, encrypted backups, and restricted administrator access. Treat database exports and backups as sensitive memory material.

The commercial/team target posture is application-layer envelope encryption for
human-readable Memory and evidence fields, sensitive treatment of embeddings,
and a tenant-scoped queryable vector representation inside the trusted backend
boundary. See
[ADR 0009](adr/0009-commercial-saas-encryption-key-management.md) and
[ADR 0010](adr/0010-managed-saas-queryable-vectors.md).

Local personal developer deployments may keep operational Memory rows readable
for debugging. Team Self-Hosted, private VPS, and Koed-managed cloud profiles
store new human-readable Memory payloads in encrypted field companions and keep
the operational source columns redacted.

Envelope encryption is provider-shaped. `local_test_key` wraps Data Encryption
Keys with `API_DATA_ENCRYPTION_KEY` for local/private operator-managed use. Paid
Koed-managed cloud must use `managed_kms`, which delegates DEK wrap/unwrap to a
managed KMS keyring and stores only provider mode, key id/version, wrapped DEK,
scope, provenance, and ciphertext metadata in app storage. KMS credentials and
raw key material must remain in deployment secret management only. Provider
status must be redacted before it reaches logs, diagnostics, status endpoints,
or support surfaces. The generic HTTP KMS adapter requires HTTPS unless the
endpoint is localhost for local tests.

BYOK and CMEK use the same envelope metadata shape but are separate provider
modes from `managed_kms` and `local_test_key`. Koed stores references, key
versions, wrapped DEKs, scope, provenance, and ciphertext only. If customer key
access is revoked, suspended, unreachable, or denied by provider policy,
decrypt-dependent operations fail closed while non-secret policy/audit metadata
remains available to explain the unavailable state. The deployment reference,
onboarding, rotation, and revocation flow is documented in
[byok-cmek-provider-reference.md](byok-cmek-provider-reference.md).

Database role and row-boundary hardening is tracked in
[database-row-boundary-safeguards.md](database-row-boundary-safeguards.md).
Hosted Team tenant isolation and support-access constraints are tracked in
[hosted-tenant-isolation-checklist.md](hosted-tenant-isolation-checklist.md).
Koed-managed cloud support/admin access is governed by
[hosted-support-admin-policy.md](hosted-support-admin-policy.md).
Managed KMS deployment proof and the `local_test_key` to KMS cutover sequence
should be recorded with the relevant private launch or staging record for each
target environment.

## Collaboration Security Boundary

Personal and Team collaboration use distinct authority even when Desktop shows
them in one application. The renderer receives schema-validated DTOs and events
through allowlisted preload IPC and never receives reusable remote credentials,
browser cookies, API Tokens, provider secrets, decrypted offline Team caches,
or a general HTTP proxy. Electron main bridges lifecycle only; local
`koed-server` owns credential custody, upstream HTTP and realtime connections,
capability validation, durable cursors, replay, and reconnect.

Personal API Tokens have no Team authority. Every Team command, route,
snapshot, replay batch, and live event rechecks current Team Membership,
Workspace Access, Share Grant, lifecycle, entitlement, credential operation
family, and resource scope before selecting or decrypting content. High-risk
device-mediated administration requires a freshly browser-confirmed, exact,
one-use action grant; enrollment does not issue reusable admin authority.

Desktop also treats rendered content as hostile. Markdown has no raw-HTML path,
safe protocols are allowlisted, remote images are disabled, oversized input is
rejected, and external links and clipboard writes use narrow trusted adapters.
Protected Team drafts, outbox items, history, recents, selections, Inspector
state, labels, and cached content are purged when backend or identity authority
changes. Unknown realtime revocation state fails closed. The tested renderer
and recovery behavior is summarized in
[Koed Desktop](desktop-ui.md#security-boundary).

Team collaboration fields and grant-scoped Shared Memory representations use
Team envelope encryption. Canonical remote replicas use a separate owner-private
envelope provider and are never read directly by Team clients. Plaintext must
not enter outbox records, replay metadata, queues, caches, audit records, logs,
metrics, diagnostics, or error responses. Authorization, key, encryption, and
outbox failures fail closed. The route and credential rules are enumerated in
[Team Collaboration Action And Credential Matrix](team-collaboration-action-credential-matrix.md),
and the complete service boundary is in
[Team Collaboration Architecture](team-collaboration.md).
