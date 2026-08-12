# Commercial SaaS Encryption And Key Management

Status: Accepted for the Team SaaS launch plan.

## Context

Koed stores Memory in Postgres, retrieves it through pgvector, LCM Summaries,
grounded exact checks over authorized semantic candidates, graph expansion, and
background worker jobs, and then uses the connected AI Client's local Memory
Answer worker for synthesis. A
hosted commercial product must reduce the blast radius of database, backup, log,
support, and infrastructure access without pretending that Koed-managed cloud is
end-to-end encrypted or zero-knowledge.

The launch system also has to run before every deployment has production KMS
credentials and BYOK/CMEK integrations. That early-deployment constraint must
not force a later rewrite. The encryption interface, payload metadata, support
policy, and deployment configuration use the same provider-shaped design from
the start, even when a private non-production deployment uses a local test key.

## Decision

Koed will target application-layer envelope encryption for human-readable
Memory and evidence fields in commercial/team deployments. It will treat
embeddings as sensitive data. It will keep only the minimum derived queryable
search representation needed for recall inside the trusted backend boundary.

Koed will not claim end-to-end encryption for Team SaaS launch.

### Launch Modes

Local personal:

- Baseline protection is encrypted disk or OS-managed storage,
  localhost-only services, local secrets, and User-controlled backups.
- Application-layer encryption may use `API_DATA_ENCRYPTION_KEY` when enabled.
- Queryable vectors can remain local because the Operator/User controls the
  machine.

Private VPS and Team Self-Hosted:

- Use application-layer envelope encryption for human-readable Memory text,
  raw source payloads, LCM source evidence, summaries, Evidence Bundle text,
  support/export bundles, sync/offload packages, and Memory Inbox/object
  payloads.
- Use encrypted volumes, encrypted backups, TLS, private dependency networking,
  hosted database role hardening, and restricted Operator access.
- Prefer Vault, cloud KMS, or another Operator-managed KMS-compatible provider
  when available.
- `API_DATA_ENCRYPTION_KEY` may be used as a local root/test key provider for a
  private operator-managed deployment, but that deployment must be documented as
  operator-managed key protection, not Koed-managed KMS.
- Redis/BullMQ or local queue payloads must not contain raw Memory text unless
  the payload is encrypted or the job only carries row IDs.

Koed-managed cloud:

- Use per-tenant envelope encryption as the target posture.
- Allow `local_test_key` only as an explicit local/development/private mode, not
  a production claim.
- Paid Koed-managed cloud must use a KMS-backed provider mode: `managed_kms`,
  `byok`, or `cmek`; API and Worker startup refuse paid cloud when configured
  with `local_test_key` or unsupported provider modes.
- Encrypt human-readable Memory text, source text, Evidence Bundle text,
  summaries, support/export bundles, sync/offload packages, object payloads,
  and canonical embeddings.
- Store a tenant-scoped queryable vector representation for pgvector search.
  This representation is sensitive derived data and remains inside the trusted
  search boundary.
- Decrypt only after route identity, Team Membership, Workspace Access, Share
  Grants, lifecycle gates, entitlement gates, and support-policy gates pass.
- Support access that reveals or exports Memory must be scoped, reasoned,
  time-bound where practical, and audited.

### Key Provider Contract

All encryption code should depend on a provider interface rather than direct
environment key reads. Supported provider modes are:

- `local_test_key`: wraps data encryption keys with `API_DATA_ENCRYPTION_KEY`.
  Allowed for local development and private/operator-managed non-production
  deployments only. It is not acceptable for paid managed SaaS production.
- `managed_kms`: Koed-managed cloud KMS. This is the paid SaaS baseline. Koed
  generates payload DEKs locally, delegates DEK wrap/unwrap to the managed KMS
  keyring, and stores only key references, key version, wrapped DEK metadata,
  scope, provenance, and ciphertext metadata in app storage.
- `operator_kms`: Team Self-Hosted or private VPS KMS/Vault/HSM integration
  controlled by the Operator. This mode is reserved until an operator KMS
  adapter is implemented; current runtime startup must fail rather than treat
  it as local test key encryption.
- `byok`: customer supplies key material through a controlled import flow that
  creates a provider reference/keyring outside ordinary app rows. Koed stores
  provider references, key version, and wrapped DEKs only; raw customer key
  material must not be stored in Postgres, logs, diagnostics, support bundles,
  or client-visible configuration.
- `cmek`: customer-managed external key reference. Koed calls the customer or
  provider KMS to wrap/unwrap Koed Data Encryption Keys according to customer
  policy. Koed stores only the external key reference, key version, wrapped
  DEKs, scope, provenance, and ciphertext metadata.

BYOK and CMEK are premium provider modes, not aliases for `local_test_key`.
Key revocation, suspension, network failure, provider policy denial, or lost
customer key access must make affected decrypt-dependent operations fail
closed: recall/rerank/evidence/source expansion/export/support/sync/restore
cannot reveal affected Memory until key access is restored or recovery policy
allows a different route. Policy metadata and audit entries should remain
available so the product can explain the failure without decrypting content.
Do not implement a fake BYOK/CMEK path that stores customer raw keys in ordinary
app tables.

Every encrypted payload must record:

- key provider mode;
- tenant/team scope;
- key id or external key reference;
- key version;
- data encryption key version or wrapped DEK id;
- algorithm and nonce/IV metadata;
- ciphertext location or column marker;
- created/re-encrypted timestamps;
- provenance for the source object or row family.

## Data Class Matrix

| Data class                                                        | Commercial/team target posture                                                                                     | Notes                                                                                                                             |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Browser/session cookies                                           | Secure cookies in hosted HTTPS; session records contain no provider tokens.                                        | WorkOS/AuthKit authenticates Users but does not provide Memory encryption.                                                        |
| API Tokens, invite tokens, device credentials                     | Store hashes, prefixes, expiry, revocation, credential references, and status metadata only.                       | Raw reusable credentials must never live in ordinary app rows.                                                                    |
| WorkOS/AuthKit API keys and provider secrets                      | Deployment secret manager or KMS-backed secret storage only.                                                       | Never expose to Explorer, MCP Server, Capture Hook config, upstream registry, logs, diagnostics, or support bundles.              |
| Database/provider/KMS credentials                                 | Deployment secret manager only, redacted everywhere.                                                               | These are control-plane secrets, not product data.                                                                                |
| Raw source rows and transcript-derived conversation items         | Application-layer encrypted text/payload fields.                                                                   | Projection and reprocessing decrypt only after internal authorization and job-boundary checks.                                    |
| Messages, tool events, Memory Events, Memory Nodes, LCM Summaries | Application-layer encrypted human-readable fields.                                                                 | Retrieval workers decrypt inside the trusted backend boundary after candidate authorization.                                      |
| Canonical embeddings                                              | Encrypted as sensitive payloads where stored for portability, rebuild, support, or export.                         | Embeddings can leak semantic information and must be treated as customer data.                                                    |
| Queryable vectors                                                 | Tenant-scoped transformed or otherwise search-boundary-limited representation by default for managed SaaS.         | This is not zero-knowledge. It is the minimum searchable representation for pgvector until stronger private search is proven.     |
| LCM lexical anchors                                               | Envelope-encrypted with each LCM Summary and included in that summary's queryable-vector input.                    | Anchors are exact-grounded synthesis output, not a standalone index; exact checks occur only over authorized semantic candidates. |
| Memory Questions, Evidence Bundles, citations, supporting context | Application-layer encrypted human-readable fields and redacted logs/support defaults.                              | Evidence is customer Memory derivative data.                                                                                      |
| Team, Workspace, Share Grant, entitlement, lifecycle metadata     | Plaintext policy metadata without raw Memory or reusable secrets.                                                  | Authorization needs inspectable IDs, statuses, and timestamps.                                                                    |
| Audit logs                                                        | Plaintext structured metadata only; no raw Memory, prompts, files, credentials, cookies, tokens, or database URLs. | Audit must be useful without becoming a content leak.                                                                             |
| Operational logs, traces, diagnostics, status files               | Redacted metadata only, stored in encrypted hosted infrastructure.                                                 | Operators need health and failure signals, not customer content.                                                                  |
| Object payloads, Memory Inbox originals, file imports             | Envelope-encrypted object storage.                                                                                 | These are first-class application-layer encryption targets.                                                                       |
| Sync packages and Offload payloads                                | Envelope-encrypted packages with explicit source/destination/provenance metadata.                                  | Sync crosses deployment and identity boundaries.                                                                                  |
| Support bundles and exports                                       | Envelope-encrypted archives with expiry, reason, actor, target, approval state where applicable, and audit record. | Support/export workflows can intentionally contain sensitive data.                                                                |
| Backups and restore bundles                                       | Provider/storage encryption plus KMS or Operator-managed backup encryption.                                        | Restore drills must prove key availability, not only archive readability.                                                         |

## Authorization Before Decrypt

Encryption does not replace authorization. The repository/API layer remains
authoritative for Team Membership, Workspace Access, Share Grants, lifecycle
state, entitlement gates, retained Team-visible knowledge, route identity, and
support policy.

Commercial/team decrypt paths must be narrow:

1. Resolve caller identity: browser session, device credential, internal worker
   identity, or audited support identity.
2. Resolve the allowed memory scope before candidate expansion.
3. Query only authorized candidate IDs or encrypted payload handles.
4. Decrypt only the selected rows needed for projection, retrieval, reranking,
   Evidence Bundle assembly, export, support, or sync.
5. Keep decrypted content out of logs, traces, metrics, status, queue payloads,
   audit metadata, and unencrypted temporary files.

WorkOS helps with step 1 for browser identity and support attribution. It does
not supply the encryption boundary or decide Memory authorization.

## Rotation, Revocation, And Recovery

- Data encryption keys are per tenant/team at minimum for managed SaaS.
  Object-class or row-family DEKs can be used below that when it improves
  rotation and blast-radius control.
- Rewrap DEKs when root KMS keys rotate.
- Re-encrypt payload bytes asynchronously only when DEKs rotate or compromise
  is suspected.
- Key metadata must allow old payloads to decrypt during rotation.
- Revoking a customer CMEK key should make affected data unavailable but
  preserve metadata needed to explain the failure and support recovery if the
  key is restored.
- Revoking or suspending a BYOK reference has the same fail-closed decrypt
  behavior unless a separately documented customer-approved recovery key exists.
- Restore drills must validate key access, wrapped DEK recovery, and encrypted
  payload readability.
- Backup retention and key retention must be aligned so retained backups remain
  restorable until their retention window ends.
- Lost Operator-managed local keys mean encrypted payloads may be unrecoverable;
  Koed should report that honestly.

## Migration And Backfill

Introduce encryption by data class with explicit migrations and backfill jobs.
Do not encrypt the entire database in one opaque step.

The first implementation should create an encrypted payload/field envelope
library, provider interface, metadata shape, and tests. Then migrate
human-readable Memory/evidence fields and object/package/archive payloads.

Current implementation status: API and Worker runtime wiring use the shared
envelope provider factory, paid Koed-managed cloud startup requires a
KMS-backed provider mode, and new paid-cloud raw `conversation_items`,
projected message/tool payloads, Memory Event payloads, and Memory Node
text/source/structured-summary fields, embedding source text, and Memory
Question query/answer/evidence/worker payloads store redacted operational rows
with full payloads in encrypted field companions.
Projection hydrates raw conversation-item companions inside the trusted
repository boundary before deriving semantic rows. Authorized graph, embedding,
retrieval, and LCM paths hydrate message, tool-event, Memory Event, Memory
Node, embedding source-text, and Memory Question payloads after repository
visibility checks. Managed/encrypted memory exports and sync/offload packages
use an encrypted package envelope with redacted manifests. Support bundles and
object payloads must use the same envelope before they can carry customer
content.

Managed SaaS has no plaintext lexical fallback or global decrypted lexical
scan. Queryable vector representation must be documented as sensitive derived
data and scoped per tenant/team. Exact hints may seed semantic queries and be
checked only over the bounded, authorized candidate set and validated encrypted
LCM anchors. Stronger options such as tenant-side search, private data planes,
or encrypted vector search remain future upgrades for high-assurance customers.

## Product Claims

Koed can honestly claim after implementation:

- TLS in transit.
- encrypted hosted infrastructure storage.
- encrypted hosted backups and restore bundles.
- application-layer envelope encryption for human-readable commercial/team
  Memory fields.
- canonical embeddings treated as encrypted sensitive customer data.
- least-privilege runtime database roles.
- redacted observability and support defaults.
- audited break-glass support where privileged access exists.

Koed must not claim:

- end-to-end encryption;
- zero-knowledge managed cloud;
- that transformed queryable vectors reveal nothing;
- that WorkOS provides Memory encryption;
- that local/private `local_test_key` is equivalent to managed KMS;
- that deleting local copies reduces cloud data unless sync/offload and
  retention policy say so explicitly.

## Follow-Up Implementation Tickets

- KOE-271: implement envelope encryption provider interface and
  `local_test_key` provider.
- KOE-272: add encrypted Memory text/evidence field migrations and backfill.
- KOE-273: define the tenant-scoped queryable vector strategy and keep
  production Recall free of plaintext lexical indexes or decrypted global scans.
- KOE-274: add managed KMS provider for paid Koed-managed cloud.
- KOE-275: add backup/export/support bundle encryption and restore-key
  validation.
- KOE-276: add BYOK and CMEK provider modes.
- KOE-277: add redaction/decrypt-path tests proving authorization happens
  before decrypt and decrypted content never enters logs, queue payloads, or
  audit metadata.
