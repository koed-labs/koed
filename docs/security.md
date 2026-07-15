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

PDS control plane and relay are not implemented by RSA envelope path. Relay uses
certificate-bound, domain-separated Ed25519 request proofs and stores canonical
encrypted transport/envelope/chunk bytes plus opaque delivery metadata only.
It never decrypts, projects, embeds, recalls, logs plaintext, source
fingerprints, Project aliases, keys, credentials, or Team fields. Authority
secret signer is deployment-secret material; Authority never stores PDS
plaintext, group secrets, device/recovery private keys, or recovery kit
material. Browser session binds governance requester identity but cannot
replace active-device/recovery authorization; browser/API Token/`Koed-Device`
authentication alone is rejected by relay. Existing directed-sync RSA code must
not be represented as PDS compliance.

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
