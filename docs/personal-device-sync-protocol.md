# Personal Device Sync Protocol V1

Status: Normative V1 profile for [ADR 0012](adr/0012-symmetric-replicated-personal-memory.md).

This document freezes Personal Device Sync (PDS) V1. The shared protocol,
Authority/Relay API, control client, secure local runtime, and Worker data plane
implement the canonical source-package and portable-derived-artifact profiles.
Receivers transactionally import compatible signed Memory Event, embedding, and
LCM node artifacts and fall back to local derivation from canonical source when
an artifact is absent or incompatible. In particular, existing
[Directed Hosted Cross-Identity Sync](self-hosted-to-hosted-sync.md) uses a
distinct RSA-OAEP target-envelope contract and must not be reused as PDS V1.
PDS is not Directed Hosted Cross-Identity Sync. It is a symmetric Personal
Device Group specialization under Cross-Identity Sync umbrella language in
[ADR 0012](adr/0012-symmetric-replicated-personal-memory.md).

## 1. Scope and trust boundary

PDS has one protocol identifier: `koed/pds/v1`. A receiver accepts only that
exact identifier. It rejects absent, older, newer, alternate, or negotiated
versions. No mixed-version window, downgrade path, or protocol fallback exists
in V1.

PDS replicates all **eligible future closed Captured Sessions** to every active
Personal Device Group device. It is relay-required. Each device remains a
symmetric local replica: capture and Recall are local, while compatible
origin-signed derived artifacts may be imported to avoid repeating Projection
or embedding work. Relay outage never stops local capture or Recall of already
materialized Memory.

The same-network V1 profile uses one fixed Authority/Relay-hosting
installation. This is an operational availability hub, not a plaintext Memory,
Projection, embedding, or Recall authority. Its outage pauses enrollment,
governance, and package transfer. V1 has no direct/multiple relay endpoint
selection and no Authority transfer or rotation ceremony.

PDS is not PostgreSQL replication, Team replication, a Personal Hub, or
Directed Hosted Cross-Identity Sync. Directed Hosted Cross-Identity Sync remains
a separate one-way protocol between distinct identities/deployments. Its
selected-source,
target authorization, RSA envelope, hosted lifecycle, and retention contracts
remain unchanged.

### Roles

| Role          | Trust and duty                                                                                                                                               | Cannot do                                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Device        | Holds one device signing key and one device KEM key. Captures, signs source manifests, verifies, decrypts, materializes, ACKs.                               | Authorize itself, alter source content, decrypt another device's envelope, grant Team access.                                                            |
| Recovery root | User-held offline governance signer plus separately held recovery KEM key. Authorizes recovery or membership/lifecycle action when no active device is used. | Act alone without authority countersignature; decrypt relay content unless given PDS keys by valid recovery process.                                     |
| Authority     | Holds authority Ed25519 signing key; CAS-writes and countersigns group log; issues bounded membership certificates; retains opaque deletion floor.           | Create membership, recovery, epoch, resolution, or tombstone action without active-device/recovery-root authorization; hold PDS plaintext or group keys. |
| Relay         | Authenticated encrypted mailbox and anti-entropy transport.                                                                                                  | Decrypt Memory, run Projection/Recall, decide authority, inspect Project aliases, or authorize Team access.                                              |

No Operator, support agent, browser session, email proof, authority-only action,
or copied API Token can add/recover/revoke a device, rotate an epoch, resolve a
conflict, or delete PDS Memory. Browser auth may bind an enrollment request to a
human identity, but does not authorize group transition.

### Same-network Desktop enrollment transport

The Desktop ceremony is specified by
[ADR 0019](adr/0019-same-network-personal-device-enrollment.md). It transports
the existing PDS challenge, signed join request, active-device approval,
membership transition, Key Bundle, and epoch acknowledgements; it does not
define an alternate membership protocol.

The one-use invitation secret remains in a URL fragment and is never sent as an
HTTP bearer credential. HKDF-SHA-256 derives an invitation transport key, and
all pairing exchanges use AES-256-GCM with direction, invitation ID, and
message ID bound as AAD. The listener permits only the exact enrollment routes
and the existing authenticated encrypted relay route. It is hosted alongside
the group's Authority/Relay by the Authority-hosting installation; joined
replicas do not receive or copy the Authority private key merely to originate
invitations. A valid invitation can request approval, but only the active
device's existing PDS signing key can authorize the transition.

Completion is not successful until the joining deployment has verified and
durably reconciled the active group state into its own database. That local
binding uses the joining deployment's local User id for Projection,
materialization, and Recall; the authority-side subject remains enrollment
provenance and is never substituted for the local User. The local group,
membership, and Personal Sync Policy must survive service restart before the
device reports synchronization as ready.

## 2. Encoding and signed bytes

All protocol JSON is RFC 8785 JCS. PDS uses pinned `json-canonicalize@2.0.0`
for JCS serialization; `packages/shared/src/canonical-json.ts` is not protocol
authority. Before parsing a signed wire value, implementation must use a raw
JSON parser that rejects duplicate object members, malformed escapes, lone UTF-16
surrogates, non-finite values, and trailing data. It then rejects input unless
byte-for-byte equal to reserialized JCS. Schemas reject unknown members. PDS
never accepts JavaScript `undefined`, numeric JSON values, non-plain objects, or
cyclic values: every numeric protocol field is a canonical decimal string.
Binary fields use unpadded base64url unless a field explicitly says `hex`; IDs
are printable opaque ASCII and never local paths.

Every uint64 JSON field, including `sequence`, epochs, cursors, counts,
`tombstoneSequence`, `chunkIndex`, and `recipientEpoch`, is a canonical unsigned
decimal string (`0` or nonzero digit followed by digits). Parser rejects signs,
leading zeroes, fractions, exponents, and values above `18446744073709551615`.
`uint64be` is exactly eight unsigned big-endian bytes. Timestamps are RFC 3339
UTC strings with exactly three fractional digits, for example
`2026-07-15T00:00:00.000Z`.

Except for two-stage records below, a signing input is exactly:

```text
UTF8("koed/pds/v1/" + recordType + "\n") || UTF8(JCS(recordWithoutSignerWrapper))
```

Permitted `recordType` values are `membership-certificate`, `source-manifest`,
`transport-envelope`, `tombstone-ack`, and `package-ack`. A signature valid for
one type is invalid for every other type. Remove whole signer wrapper, including
key ID and signature: `authoritySignature`, `originSignature`,
`servingSignature`, or `signature`, as applicable. Authority wrappers use
`keyId`; device/recovery wrappers use `signerKeyId`.

Two-stage `group-statement`, `key-bundle`, `tombstone`, and
`conflict-resolution` records use exact domains:

```text
active-device/recovery authorization: UTF8("koed/pds/v1/" + recordType + "/draft\n") || UTF8(JCS(draft))
Authority countersignature:            UTF8("koed/pds/v1/" + recordType + "/final\n") || UTF8(JCS({draft, authorization}))
```

The authorization signs only `draft`. Authority verifies it, then signs the
finalized `{draft, authorization}` value. Fully finalized record hash is
`base64url(SHA256(UTF8(JCS({draft, authorization, authority}))))`; it includes
both wrappers. `previousHash` always names that exact prior finalized hash.

SHA-256 is `SHA256(bytes)`. Content hashes and log heads are base64url SHA-256.
`packageId` is derived before source-manifest signing. Its preimage is JCS of
source manifest with `packageId` and `originSignature` omitted:
`base64url(SHA256(UTF8("koed/pds/v1/package-id\n") || UTF8(JCS(preimage))))`.
`sourceManifestHash` is SHA-256 of complete source manifest with only
`originSignature` omitted. The source-manifest signature then covers complete
manifest with only `originSignature` omitted. This ordering has no circular ID
input.

## 3. Keys and key separation

All asymmetric key values are exactly 32 raw bytes. Ed25519 uses RFC 8032 raw
public keys and 32-byte secret seeds. X25519 uses RFC 7748 raw public and
private values. PEM, DER, JWK, RSA, Ed25519/X25519 key conversion, and a key
used in more than one role are invalid PDS V1 inputs.

| Material                  | Algorithm                    | Scope                     | Prohibited reuse                     |
| ------------------------- | ---------------------------- | ------------------------- | ------------------------------------ |
| Device signing key        | Ed25519                      | one device                | KEM, recovery, authority, HMAC       |
| Device KEM key            | X25519                       | one device                | signing, recovery, authority, HMAC   |
| Recovery root signing key | Ed25519                      | one Personal Device Group | every device/authority key           |
| Recovery KEM key          | X25519                       | one Personal Device Group | every device/authority key           |
| Authority signing key     | Ed25519                      | authority service         | device/recovery key                  |
| `K_epoch[e]`              | random 32-byte symmetric key | one membership epoch      | fingerprints, tombstones, Projects   |
| `K_source`                | random 32-byte HMAC key      | group lifetime            | encryption, tombstones, Projects     |
| `K_tombstone`             | random 32-byte HMAC key      | group lifetime            | encryption, fingerprints, Projects   |
| `K_project[e]`            | random 32-byte HMAC key      | one epoch                 | encryption, fingerprints, tombstones |

`K_source`, `K_tombstone`, and each `K_project[e]` are independently random;
none is derived from an epoch key. `K_epoch[e]` is independently random and is
used only to derive encrypted anti-entropy cursor authentication keys:
`HKDF-SHA-256(K_epoch[e], SHA256(UTF8("koed/pds/v1/cursor/salt")),
UTF8("koed/pds/v1/cursor/key"), 32)`. It is never a content, fingerprint,
tombstone, or Project key. Epoch rotation creates fresh `K_epoch[e]` and
`K_project[e]`; it does not change historical source fingerprints or
deletion-floor identifiers. Key records are recipient-envelope-delivered only
to devices authorized by current group log. Private keys and symmetric keys
never enter Authority or Relay storage.

### Source fingerprint

For a stable source-native Session ID, source fingerprint is:

```text
HMAC-SHA-256(K_source,
  UTF8("koed/pds/v1/source-fingerprint\0captured_session\0") ||
  UTF8(sourceNativeSessionId))
```

It is encrypted package content. Never derive it from database IDs, paths,
checkouts, device IDs, unsalted hashes, or Project signals.

`logicalMemoryId` and `deletionFloorToken` remain inside same encrypted signed
source manifest. Their derivation and irreversible floor semantics are section
8; raw identifiers never reach Relay or Authority.

## 4. Group creation, recovery, membership

First-device setup generates separate device signing/KEM keys, recovery signing
and recovery KEM keys, all initial PDS symmetric keys, and an encrypted recovery
kit. Before genesis is submitted, User must decrypt kit with recovery KEM key,
verify root public-key fingerprints, group id, and initial authority public-key
fingerprint, then explicitly confirm stored offline recovery material. Genesis
is invalid without signed `recoveryKitVerified: true` from first device and
Authority countersignature. Recovery kit must be stored separately from ordinary
device credentials, API Tokens, browser data, `KOED_HOME`, and relay state.

Loss of every active device and recovery kit permanently loses group control.
Recovery restores governance and available retained packages; it cannot recreate
lost source bytes.

### CAS group log and membership epochs

A `GroupStatement` is exactly this two-stage wrapper:

```json
{
  "draft": {
    "protocol": "koed/pds/v1",
    "kind": "genesis|add-device|revoke-device|recover|tombstone|resolve-conflict",
    "groupId": "opaque-group-id",
    "sequence": "1",
    "previousHash": null,
    "body": {}
  },
  "authorization": { "signerKeyId": "...", "signature": "..." },
  "authority": { "keyId": "...", "signature": "..." }
}
```

No field, including timestamp, exists outside `draft`. `draft` contains exactly
`protocol`, `kind`, `groupId`, `sequence`, `previousHash`, and `body`.
Authorization and countersigning bytes are section 2's `group-statement/draft`
and `group-statement/final` domains. The finalized record hash is used for
`previousHash`; implementations must never hash a draft, omit either signature,
or use a differently wrapped statement as log head.

`body` has exactly one shape by `kind`:

- `genesis`: `authorityKeyId`, `authorityPublicKey`, `recoverySigningKeyId`,
  `recoverySigningPublicKey`, `recoveryKemKeyId`, `recoveryKemPublicKey`,
  `recoveryKitHash`, **`recoveryKitVerified: true`**, `initialDeviceId`,
  `initialDeviceSigningKeyId`, `initialDeviceSigningPublicKey`,
  `initialDeviceKemKeyId`, `initialDeviceKemPublicKey`, `operationFamilies`,
  `initialEpoch`, and `initialKeyCommitment`. Genesis authorization is verified
  with that embedded initial-device signing public key (and its `signerKeyId`); recovery-root
  verification and the Authority countersignature rules still apply. No
  unrecorded or out-of-band device key material may satisfy genesis verification;
- `add-device`: new `deviceId`, signing/KEM key IDs and public keys,
  `operationFamilies`, `previousEpoch`, `nextEpoch`, `keyBundleHash`;
- `revoke-device`: `deviceId`, `reasonCode`, `revokedAt`, `previousEpoch`,
  `nextEpoch`, `keyBundleHash`;
- `recover`: replacement device signing/KEM IDs and public keys,
  `recoveryKitHash`, `previousEpoch`, `nextEpoch`, `keyBundleHash`;
- `tombstone`: `tombstoneHash` and `deletionFloorToken` from signed tombstone;
- `resolve-conflict`: `sourceFingerprint`, `selectedClosureHash`, and
  `resolution` (`select` or `distinct`).

Every key ID is opaque ASCII; public keys are raw 32-byte base64url;
`sequence`, epochs, and times/counts are canonical decimal strings.
`operationFamilies` contains only `pds_relay`. `sequence` increments by one;
`previousHash` is mandatory CAS input. Persisted statement history orders decimal
sequence values numerically, never lexically. Authority atomically accepts only
current hash and next sequence, verifies draft authorization, persists valid
required bundle(s), and countersigns. CAS conflict returns current signed head;
client rereads and creates a new explicit transition. It must never silently
retry against changed state.

Every `add-device`, `revoke-device`, and `recover` atomically advances from
`previousEpoch` to `nextEpoch = previousEpoch + 1`. Its `keyBundleHash` must
identify a valid finalized Key Bundle with recipient envelopes for **every
post-transition active device and recovery recipient**. Authority commits bundle
and statement in one transaction. No transition is active, no membership
certificate for `nextEpoch` is issued, and all package exchange is frozen until
that transaction commits and every required envelope validates. A missing,
invalid, duplicate, unordered, wrong-epoch, or incomplete bundle freezes
exchange; it is not a partial-membership state. Revoked recipients are absent
from post-transition snapshot. Existing members and recovery recipient receive
fresh `K_epoch[nextEpoch]` and `K_project[nextEpoch]`; source and tombstone
keys are re-enveloped unchanged. Authority never receives plaintext keys.

Authority signs a membership certificate only for active group-log device key
material. Certificate renewal and repair revalidate active governance, no pending
epoch, exact current head and epoch, device key bindings, and Authority key ID in
one transaction before replacing stored certificate bytes. It has exactly `protocol`, `groupId`, `deviceId`, `deviceSigningKeyId`,
`deviceSigningPublicKey`, `deviceKemKeyId`, `deviceKemPublicKey`, `epoch`,
`operationFamilies`, `statementSequence`, `statementHash`, `issuedAt`,
`expiresAt`, and `authoritySignature` (`keyId`, `signature`).
`authoritySignature` is omitted from membership-certificate bytes. A certificate
must reference the exact group statement which establishes its device keys and
its epoch (genesis for epoch 1, or the matching committed transition thereafter).
Its lifetime is strictly positive and no more than 7 days: `issuedAt <
expiresAt`. Receiver permits 5 minutes `issuedAt` skew, requires `now <
expiresAt`, and rejects zero, negative, or over-7-day stated lifetime. Cached
expiry blocks relay send/receive; local capture/Recall continue.

A membership/log fork, same sequence with different bytes, invalid prior hash,
mismatched Authority countersignature, concurrent Authority lease, duplicate
device signing/KEM key use, or duplicate origin sequence with different closure
is clone suspicion. Device quarantines affected records, freezes exchange,
revokes implicated membership through valid group action, and requires
re-enrollment with fresh device keys. Perfect same-path clone use alternating
offline remains indistinguishable; V1 does not claim guaranteed clone
detection. Authority equivocation similarly enters **equivocation freeze**: no
enroll, revoke, recovery, key delivery, package upload/download/serve, or
tombstone action. Local capture and Recall continue. Freeze clears only after
valid group-authorized, Authority-countersigned resolution extends one verified
head.

### Key Bundle and recipient envelopes

A versioned, signed `KeyBundle` delivers one secret set only through recipient
X25519 envelopes. It is never Authority plaintext. It is exactly:

```json
{
  "draft": {
    "protocol": "koed/pds/v1",
    "version": "1",
    "groupId": "opaque-group-id",
    "epoch": "2",
    "transitionKind": "add-device|revoke-device|recover",
    "recipientSnapshot": ["opaque-recipient-id"],
    "recipientSnapshotHash": "base64url-sha256",
    "keyType": "group-secret-set",
    "epochKeyCommitment": "base64url-sha256",
    "sourceFingerprintKeyCommitment": "base64url-sha256",
    "tombstoneFloorKeyCommitment": "base64url-sha256",
    "projectAliasKeyCommitment": "base64url-sha256",
    "envelopes": []
  },
  "authorization": { "signerKeyId": "...", "signature": "..." },
  "authority": { "keyId": "...", "signature": "..." }
}
```

`recipientSnapshot` is unique, ASCII sorted, and equals post-transition active
devices plus exactly one recovery recipient. `recipientSnapshotHash` is SHA-256
of its JCS array. `keyBundleHash` is SHA-256 of the JCS object containing the
exact `draft` and device `authorization`. This stable pre-acceptance identifier
lets the device bind the transition before the Authority countersignature
exists. The Authority countersignature still authenticates final acceptance and
is mandatory on every stored or served Key Bundle.
Commitments are SHA-256 of exact 32-byte key values. `epoch` is `nextEpoch`;
`keyType` is exactly `group-secret-set`; `version` is exactly `1`.

Each envelope is exactly `recipientId`, `recipientKind` (`device` or
`recovery`), `recipientKemKeyId`, `ephemeralPublicKey`, `nonce`, `ciphertext`,
`tag`, and `envelopeContext`. Its plaintext is JCS object with exactly
`epochSecret`, `sourceFingerprintKey`, `tombstoneFloorKey`, and
`projectAliasKey`; all are 32-byte base64url. `envelopeContext` is exactly
`koed/pds/v1/key-bundle-envelope`.

For each envelope, generate a fresh X25519 ephemeral key pair and compute
`sharedSecret = X25519(ephemeralPrivate, recipientKemPublic)`. Reject an output
that is not exactly 32 bytes or is all zero bytes. Do not cofactor-adjust,
retry, or substitute a key. The Key Bundle construction is distinct from the
package recipient-envelope construction:

```text
salt = SHA256(UTF8("koed/pds/v1/key-bundle/salt\\0") || UTF8(groupId))
info = UTF8("koed/pds/v1/key-bundle/key\\0") || uint64be(epoch) ||
       UTF8(recipientId) || 0x00 || UTF8(recipientKind) || 0x00 ||
       UTF8(recipientKemKeyId) || 0x00 || UTF8(keyType) || 0x00 ||
       UTF8(recipientSnapshotHash)
wrappingKey = HKDF-SHA-256(sharedSecret, salt, info, 32)
```

`uint64be(epoch)` is the eight-byte unsigned big-endian encoding of the parsed
canonical decimal epoch. Encrypt the UTF-8 JCS plaintext with AES-256-GCM using
that exact 32-byte `wrappingKey`, a 12-byte nonce, and a 16-byte tag. Its AAD is
UTF-8 JCS of exactly `protocol`, `version`, `groupId`, `epoch`, `recipientId`,
`recipientKind`, `recipientKemKeyId`, `keyType`, and `recipientSnapshotHash`.
Derivation never includes ciphertext, tag, or a hash containing either.

Envelopes sort by `recipientId`; each recipient appears once. Validate recipient
identity, kind, membership snapshot, epoch, and KEM key ID before deriving;
then validate ephemeral/nonce/tag lengths, all-zero shared-secret rejection,
AEAD, canonical plaintext shape and lengths, commitments, and both signatures
before marking transition usable. Bundle records and envelopes are retained
through recovery and replay validation; duplicate same hash is idempotent, same
transition/epoch with different bytes quarantines. Key Bundle retrieval requires
active governance and exact current or pending epoch, but does not require an
active device: final-device recovery can retrieve its recovery bundle after that
device is revoked. Frozen governance blocks Key Bundle and certificate retrieval.
Revocation removes future delivery but cannot erase already received plaintext.

## 5. Closed Captured Session source package

Only future Sessions closed after PDS policy activation are eligible. V1 sends
one immutable closed-Session package per source origin. Open Sessions,
historical backfill, Project-wide/all-memory packages, mutation after closure,
and partial device placement are non-V1.

`source-manifest` is encrypted content and has exactly these fields; unknown
fields are rejected. `projectAliasManifest` may be omitted only where no
canonical remote alias exists:

```json
{
  "protocol": "koed/pds/v1",
  "packageId": "base64url-sha256",
  "originDeploymentId": "opaque-id",
  "originDeviceId": "opaque-id",
  "sourceSequence": "7",
  "sourceType": "captured_session",
  "sourceNativeSessionId": "opaque-source-id",
  "sourceFingerprint": "base64url-hmac-sha256",
  "logicalMemoryId": "base64url-hmac-sha256",
  "deletionFloorToken": "base64url-hmac-sha256",
  "sourceClosureHash": "base64url-sha256",
  "contentEpoch": "3",
  "projectAliasManifest": { "version": "1", "epoch": "3", "tokens": [] },
  "closedSession": {
    "closed": true,
    "sourceAdapter": "adapter-id",
    "sourceAdapterVersion": "version",
    "captureMethod": "transcript",
    "sourceCreatedAt": "2026-07-15T00:00:00.000Z",
    "sourceClosedAt": "2026-07-15T00:00:01.000Z",
    "observedClosedAt": "2026-07-15T00:00:02.000Z"
  },
  "terminal": { "cursor": "1", "itemCount": "1" },
  "rawClosure": { "recordCount": "1", "rawByteCount": "1", "records": [] },
  "originSignature": { "signerKeyId": "opaque-id", "signature": "base64url" }
}
```

`rawClosure.records` is ordered and each record has exactly `ordinal`
(canonical decimal string), `sourceNativeItemId`, `sourceTimestamp`,
`observedAt`, `payload` (base64url original raw bytes), and `payloadHash`
(base64url SHA-256). `recordCount` equals records length; `rawByteCount` equals
sum of decoded `payload` byte lengths; and
`sourceClosureHash = base64url(SHA256(UTF8(JCS(rawClosure.records))))`.
Payload plaintext is exactly UTF-8 JCS of one complete immutable source item.
`originSignature` is excluded only for source-manifest hash, package-id preimage,
and source-manifest signature bytes as defined in section 2.

Closure is contiguous ordered raw source observations with ordinals `0..n-1`,
no gaps, and no duplicate ordinal. Origin attests immutable `terminal.cursor`
and `terminal.itemCount`, and receiver verifies that item count, ordinal range,
raw hashes, closure hash, manifest ID, and origin signature before
materialization. Without an independently signed source feed, receiver can
verify internal closure consistency only; it cannot prove origin omitted no
source records. Raw source records retain original source payload bytes plus
source-native identity, source order, and observation provenance. For Koed
Conversation source items, the shared package implementation accepts only UTF-8
JCS payloads with exactly `sourceNativeItemId`, `sequence`, `sourceTimestamp`,
`observedAt`, `actor`, `type`, `content`, and `metadata`. `sequence` equals
record `ordinal`; `actor` is the canonical source actor and `type` is the
source event classification needed by the receiving device's local Projection.
Metadata permits only `contentType`, `sourceRole`, `toolName`, and `toolCallId`,
each a bounded string. This is an immutable source-item profile, not a derived
Memory/Event schema. Paths, credentials, Team fields,
queue/database identifiers, derived Memory structures, and unknown metadata
fail closed.

The immutable source manifest excludes derived data. Derived Personal data uses
a separate artifact package so later Projection or embedding completion cannot
mutate the origin-signed source closure. Artifact packages bind source
fingerprint, source closure hash, artifact class, portable schema version,
producer device, compatibility contract, ordered content hashes, and payload
hash before device signing and normal recipient encryption.

The V1 artifact registry initially permits:

- `memory_event/v1`, containing portable projected-event data with stable source
  item bindings and no database primary keys;
- `memory_embedding/v1`, containing the logical source content hash, receiver-
  verifiable canonical full-source text hash, exact chunk text hash, canonical
  vector, and the exact embedding contract: model artifact identity,
  dimensions, tokenizer and input transformation, pooling, normalization, and
  embedding version;
- `lcm_node/v1`, containing a leaf or rollup bound to its exact ordered logical
  source identities and complete LCM compatibility contract.

The receiver verifies group membership, signatures, source binding, payload
hash, artifact schema, and contract compatibility before a transactional,
idempotent upsert. A compatible artifact is trusted because its producer is an
active explicitly enrolled Personal device. An incompatible or unavailable
artifact is ignored without weakening source replication and is rebuilt from
the canonical source closure. Local HNSW/vector indexes, queue state, leases,
credentials, paths, and operational rows are never artifact payloads.

Before importing a vector, the receiver derives the source through its normal
embeddable-source path, including authorized decryption. It must match the
artifact's canonical full-source text hash and portable source hash. This
proves every chunk belongs to the receiver's exact logical source without
requiring the database importer to reproduce llama-server token boundaries.

`modelArtifactHash` and embedding `sourceHash` use lowercase SHA-256 hex because
they bind the installed model artifact and local embedding-source contract.
Logical identities, source-content hashes, source-text hashes, vector hashes,
payload hashes, and closure hashes use unpadded SHA-256 base64url.

Artifact types are registered explicitly in code. Every future durable Personal
data class must be classified as replicated, locally derived, or device-local,
with tests. Unknown classes and versions fail closed independently and do not
invalidate an otherwise valid canonical source package. Team-owned data is not
admitted merely because a local table contains it; its Team authority,
revocation, and retention protocol remains controlling.

Semantic work claims are separate signed coordination records. They bind
`groupId`, stable `workIdentity`, `workClass`, claimant device, compatibility
contract hash, claim generation, claim time, and expiry. Artifact publication
must present the current claim generation. Physical queue leases remain local
and are never replicated.

The unfinished LCM frontier is deterministic state, not another replicated
mutable record. It is reconstructed from ordered logical Memory Events after
subtracting complete, current `lcm_node/v1` leaf coverage. Managed Conversation
handoff transfers source authority, so the new source device reconstructs and
continues the same frontier. Fork finalizes the parent at the exact fork
boundary, including a below-threshold tail, and starts the child from its
distinct logical source lineage. A compatible enrolled device may claim
embedding work when the execution device does not advertise a ready compatible
embedding capability.

An embedding capability advertisement is signed, expires after a bounded
interval, and names the exact embedding compatibility-contract hash. A new
embedding claim requires a fresh `ready` advertisement for that contract. An
existing claimant may renew only the same work identity, work class, claimant
device, source binding, and compatibility contract. Local embedding dispatch
for synchronized Memory Events or LCM nodes requires that exact active claim;
an approximate model match or stale capability cannot admit the work.

Materialized replica source identity, provenance, ordering, and source payload
remain immutable. Local Projection may update only its allowlisted processing
fields on mapped source items. The receiving device may also maintain the
allowlisted derived title fields on the local Session record; those fields are
not origin source, do not alter the signed closure, and are not authority for a
later package. Any other mutation or deletion of a materialized source Session
or mapped source item fails closed.

Equal source fingerprint plus equal closure hash converges to one logical
Memory identity while preserving both origin observations. Equal fingerprint
plus different closure hash is **quarantine**: store redacted provenance,
exclude all conflicting variants from Projection and Recall, and never choose
last writer. Only valid group-authorized/Authority-countersigned two-stage
`conflict-resolution` is accepted. Its `draft` has exactly `protocol`,
`groupId`, `sourceFingerprint`, `candidateClosureHashes`,
`selectedClosureHash`, `resolution` (`select` or `distinct`), `statementHash`,
and `issuedAt`; wrappers and signing domains are section 2. `select` requires
exactly one selected candidate; `distinct` requires
`selectedClosureHash: null`. Sources without trustworthy stable native ID remain
distinct.

The accompanying `resolve-conflict` group statement body has exactly
`resolutionHash`, `sourceFingerprint`, `selectedClosureHash`, and `resolution`.
`resolutionHash` is the finalized conflict-resolution record hash. Receivers
verify this exact record commitment, the semantic fields, and that the record's
`statementHash` equals the statement's `previousHash` before applying it.

## 6. Encryption and recipient envelopes

Transport uses TLS and PDS end-to-end encryption. Each serving transport
encrypts exact immutable origin-manifest bytes under fresh random 32-byte content
encryption key (CEK), then recipient-envelopes CEK for every active recipient.
Re-serving preserves origin manifest, closure, package ID, and source-manifest
hash, but creates fresh CEK, payload nonce, transport ID, ciphertext, recipient
envelopes, and serving signatures.

### Ciphertext

Payload uses AES-256-GCM with random 96-bit nonce. CEK must be generated by OS
CSPRNG and used once. Payload AAD is UTF-8 JCS of complete serving transport
header excluding `payloadCiphertextHash`, `payloadTag`, and `servingSignature`.
It binds protocol/version, transport and group IDs, package and source-manifest
hashes, origin and serving devices, content/recipient epochs, plaintext/chunk
bounds, nonce, expiry, Authority head, and intended recipient snapshot/hash.
`contentEpoch` is immutable source-package metadata. Nonce reuse under a CEK is
fatal and package is rejected. Compression is forbidden before or after
encryption.

### X25519 recipient CEK envelope

For every recipient, source/serving device creates fresh ephemeral X25519 key
pair. `sharedSecret = X25519(ephemeralPrivate, recipientKemPublic)`. Reject if
output is not exactly 32 bytes or is all zero bytes. Do not cofactor-adjust,
retry, substitute keys, or continue with zero output.

For a recipient envelope, `recipientEpoch` is current group epoch at envelope
creation and can differ from immutable `contentEpoch`. Bytes are exact:

```text
salt = SHA256(UTF8("koed/pds/v1/envelope/salt\0") || UTF8(groupId))
info = UTF8("koed/pds/v1/envelope/key\0") || uint64be(recipientEpoch) ||
       UTF8(packageId) || 0x00 || UTF8(recipientDeviceId) || 0x00 ||
       UTF8(senderDeviceId)
wrappingKey = HKDF-SHA-256(sharedSecret, salt, info, 32)
```

`uint64be(recipientEpoch)` is unsigned eight-byte big-endian parsed from its
canonical decimal string. Envelope CEK encryption is AES-256-GCM using
`wrappingKey`, CSPRNG 96-bit nonce, and JCS UTF-8 AAD:

```json
{
  "recipientEpoch": "3",
  "packageId": "...",
  "recipientDeviceId": "...",
  "senderDeviceId": "..."
}
```

Recipient envelope fields are exactly `protocol`, `version`, `transportId`,
`packageId`, `contentEpoch`, `recipientEpoch`, `senderDeviceId`, `recipientDeviceId`,
`recipientKemKeyId`, `ephemeralPublicKey` (raw 32-byte base64url), `nonce`
(12-byte base64url), `ciphertext` (32-byte base64url CEK), `tag` (16-byte
base64url), and `servingSignature` (`signerKeyId`, `signature`).
It is signed under `transport-envelope` with `servingSignature` omitted. Reject
missing/unknown fields, wrong lengths, recipient/key epoch mismatch, failed
AEAD, stale membership, or bad signature. Re-serving preserves only immutable
origin content and creates fresh ciphertext/header/envelopes under current
recipient epoch.

## 7. Relay, package, replay, and retention

Relay accepts only current valid membership certificate and signed transport
header. Package implementations construct an opaque runtime context only after
cryptographically verifying Authority-signed membership certificates against
configured Authority public key and current log head/epoch. Callers cannot
supply keys, heads, epochs, or recipient snapshots to package verification.
Public package verification accepts bounded canonical UTF-8 wire bytes only;
objects are not a wire input. Header has exactly `protocol`, `version`,
`transportId`, `groupId`, `packageId`, `sourceManifestHash`, `originDeviceId`,
`contentEpoch`,
`recipientEpoch`, `plaintextByteCount`, `chunkCount`, `payloadNonce`,
`payloadCiphertextHash`, `payloadTag`, `expiresAt`, `servingDeviceId`,
`servingSigningKeyId`, `authorityHead`, `intendedRecipientSnapshot`,
`intendedRecipientSnapshotHash`, and `servingSignature` (`signerKeyId`,
`signature`). Signature bytes omit whole `servingSignature` wrapper. Snapshot is
unique ASCII-sorted active device IDs at acceptance; its hash is SHA-256 of its
JCS array. Relay validates submitted snapshot against current authority head and
persists exact snapshot/hash and `relayAcceptedAt` atomically with package
acceptance. It rejects snapshot mismatch, stale membership, expiry, or
re-acceptance with different snapshot.
`payloadNonce` is 12-byte base64url, `payloadTag` is 16-byte base64url, and
`payloadCiphertextHash` is base64url SHA-256 of
`payloadCiphertext || payloadTag`; `payloadCiphertext` is concatenation of chunk
`ciphertext` in ascending `chunkIndex`. Shared package V1 serializes this as a
fresh, signed serving transport header with `version`, `transportId`,
`recipientEpoch`, `servingDeviceId`, `servingSigningKeyId`, `authorityHead`,
and `servingSignature` in addition to header bindings above. The serving
signature uses `transport-envelope` bytes and binds exact group, Authority
head, origin, content, recipient snapshot/epoch, nonce, expiry, and format. An origin is a
serving replica for its initial upload. A re-serving replica creates fresh CEK,
payload nonce, transport ID, ciphertext, recipient envelopes, and serving
signature while preserving exact origin manifest and source-manifest hash.
Retries reuse exact transport bytes; recipient/snapshot/epoch changes require a
fresh transport. Each chunk has
exactly `protocol`, `version`, `transportId`, `groupId`, `packageId`,
`chunkIndex`, `chunkCount`, `ciphertext`, and `chunkHash`. It sees
encrypted chunks plus redacted metadata: opaque group/source/
target IDs, package id/hash, epoch, byte count, chunk count/index, expiry,
delivery state, and retry cursor. It may observe IP address, timing, size,
frequency, and device relationship. It must not receive raw Session IDs,
fingerprints, Project aliases, plaintext, keys, signatures' signed content,
Credentials, or local paths in logs/metrics.

Limits are hard limits before persistence:

| Object                                 |     Limit |
| -------------------------------------- | --------: |
| package plaintext/ciphertext           |    64 MiB |
| encrypted chunk                        |   512 KiB |
| chunks per package                     |       128 |
| control statement/certificate          |     1 MiB |
| recipients per package                 |        64 |
| outstanding encrypted bytes per sender |     2 GiB |
| retained encrypted bytes per group     |    10 GiB |
| compression                            | forbidden |

Relay retains undelivered package bytes for 30 days from accepted upload.
Every init, upload, metadata/read, exact chunk read, commit, ACK, and cursor
operation locks and rereads current active Group/member/certificate/head/epoch
with no pending epoch in same transaction as its data action. A lifecycle race
therefore fails action rather than trusting cached authorization.

The Relay exposes an authenticated held wake request for package, membership,
key-epoch, conflict, and tombstone availability. A wake contains no plaintext
or authorization result and is never durable authority. Devices reconcile
bounded mailbox and lifecycle state after startup, reconnect, or a wake.
Listening begins before the durable mailbox check, closing the check/listen
race. Duplicate or missed wakes are harmless. Continuous interval polling is
not a V1 synchronization path; connection recovery backoff and persisted retry
due-times may schedule bounded reconciliation.

`PackageAck` is exactly `protocol`, `groupId`, `transportId`, `packageId`,
`sourceManifestHash`, `recipientDeviceId`,
`intendedRecipientSnapshotHash`, `relayAcceptedAt`, `ackedAt`, `result`
(`materialized`), and `signature` (`signerKeyId`, `signature`). It signs
`package-ack` bytes with `signature` omitted. Relay accepts ACK only once
receiver has validated signed header, exact persisted transport/package/snapshot
identity and `relayAcceptedAt`, current recipient membership, ciphertext,
envelopes, source manifest, and authority deletion floor before materialization.
Same ACK bytes are idempotent; same `(groupId, transportId, packageId,
recipientDeviceId)` with different hash, result, snapshot, or signature
quarantines and does not count.

The sender records upload acceptance as `committed`, not delivered. Its durable
outbox advances to `acked` only after an authenticated transport read confirms
that every intended recipient snapshot member has a valid ACK. The held wake
request includes only opaque pending transport IDs, begins listening before its
durable mailbox and ACK checks, and wakes both recipients with pending packages
and senders whose transports became fully acknowledged. A lost notification is
therefore repaired by the post-listen durable check without interval polling.
The receiver keeps its local inbox leased until materialization, relay ACK, and
durable local completion all succeed; an ACK failure leaves the inbox
retryable.

After every snapshot recipient ACKs, relay deletes encrypted chunk bytes and
recipient envelopes 7 days later. If a snapshot recipient is revoked **after
acceptance**, only a valid finalized revoke statement waives that recipient;
relay retains waiver hash. A revoked recipient cannot ACK after revocation. On
expiry relay deletes encrypted chunk bytes and envelopes, records bounded
redacted receipt metadata, creates no tombstone, and accepts no successful ACK;
an authorized active replica must re-upload same immutable package under a
fresh header/current recipient snapshot. Recovery recipient may re-serve
retained validated package after membership recovery, subject to current
epoch/bundle and deletion-floor checks. Retention expiry never changes local
replicas.

Receiver replay table key is `(groupId, packageId)`. Same id and same signed
source-manifest hash is idempotent. Same id with different hash is tampering:
quarantine, do not overwrite, do not ACK success, and report redacted failure.
Chunk checksums, index/count, package hash, and complete ciphertext hash must
validate before decrypt. Relay must allow authorized replica re-serving only
when immutable source hash remains identical and fresh serving signature/
recipient envelope validates.

## 8. Lifecycle, deletion, restore

PDS device revocation, replica removal, PDS pause, Personal deletion, Team
Share Grant revocation, and Team retention remain separate. PDS never mutates
Team Membership, Workspace Access, Share Grants, or Team-retained knowledge.

`logicalMemoryId` and `deletionFloorToken` are opaque authenticated values
included inside signed encrypted source manifest and signed tombstone. Origin
derives both from source fingerprint, not source sequence:

```text
logicalMemoryId = HMAC-SHA-256(K_tombstone,
  UTF8("koed/pds/v1/logical-memory-id\0") || UTF8(sourceFingerprint))
deletionFloorToken = HMAC-SHA-256(K_tombstone,
  UTF8("koed/pds/v1/deletion-floor\0") || UTF8(sourceFingerprint))
```

Personal deletion tombstone is exact two-stage `tombstone` record whose `draft`
has exactly `protocol`, `groupId`, `logicalMemoryId`, `sourceFingerprint`,
`deletionFloorToken`, `closureHashes`, `tombstoneSequence`, `statementHash`,
`activeDeviceSnapshot`, and `issuedAt`. It needs active-device or recovery-root
authorization and Authority countersignature. Authority verifies token matches
manifest's authenticated value but never derives it or holds `K_tombstone`.
Authority persists token, logical ID, finalized tombstone hash, and tombstone
sequence as signed authority floor. It stores no Memory plaintext, raw source
ID, fingerprint, or key.

The accompanying `tombstone` group statement body commits the finalized
`tombstoneHash` and exact `deletionFloorToken`. Receivers also verify that the
tombstone draft's `statementHash` equals the statement's `previousHash`; a
valid record and valid statement cannot be recombined across lifecycle actions.

V1 deletion is irreversible for that exact `logicalMemoryId`/floor token until
irreversible group purge. Receiver fetches and verifies signed Authority floors
before downloading, decrypting, or materializing package. Matching
`logicalMemoryId` and `deletionFloorToken` rejects package regardless of source
sequence, tombstone sequence, source origin, or delivery order. It must never
compare unrelated source and tombstone sequences. Restore never lowers local
floor state; a package cannot resurrect deleted logical Memory.

At tombstone creation Authority snapshots exact active device IDs. `tombstone-ack`
has exactly `protocol`, `groupId`, `tombstoneHash`, `deviceId`, `statementHash`,
`ackedAt`, and `signature` (`signerKeyId`, `signature`); it signs `tombstone-ack`
bytes with `signature` omitted. Device ACKs after local removal/quarantine of
matching source and derived state. Full tombstone remains until all snapshot
ACKs plus 30 days. A valid finalized revoke can waive a recipient after snapshot;
otherwise revoked-after-snapshot device remains required.

## 9. Project aliases

Project association is local grouping/search context only. It never grants Team
access or chooses a Workspace. Raw aliases, paths, remotes, and canonical alias
text never leave encrypted package boundary. Signed source manifest contains
exact `projectAliasManifest`:

```json
{
  "version": "1",
  "epoch": "3",
  "tokens": ["base64url-hmac-sha256"]
}
```

It is absent only when no canonical remote alias exists. `tokens` is unique,
ASCII sorted, maximum 16 entries; every token is 32-byte HMAC output base64url.
`version` is exactly `1`; `epoch` must equal manifest `contentEpoch` and a
verified `K_project[epoch]`. Token is exactly:

```text
HMAC-SHA-256(K_project[epoch], UTF8("koed/pds/v1/project-alias\0") || UTF8(alias))
```

Canonical alias is normalized network host (lowercase, IDNA), namespace, and
repository name after stripping credentials, default port, `.git` suffix, and
transport spelling. Local-only paths have no alias. Receiver rejects raw alias
fields, mismatched version/epoch, oversized or unordered token set, bad token
length, or unverified project epoch.

Auto-match only when exactly one token intersects and maps to exactly one local
Project on each device, with no explicit deny/manual override and no competing
current/historical token. Zero or multiple tokens, collisions, forks, changed
canonicalization, local-only Projects, or any competing Project requires User
confirmation. User override wins until removed.

## 10. Observability and operational state

Status may expose group state (`active`, `certificate_expiring`,
`equivocation_freeze`, `quarantine`, `relay_unavailable`), membership-log head,
redacted package/chunk counts and bytes, age, retry class, ACK lag, epoch,
tombstone-ACK count, and quota state. It must not expose Memory, raw IDs,
fingerprints, aliases, key bytes, nonces, ciphertext, package manifest content,
credentials, recovery kit, or full relay URLs.

Relay and Authority must audit redacted transition type, group opaque ID, log
sequence/head, actor key id, outcome, and timestamp. They must not log signed
body, signatures, browser identity, support identity, email, key material, or
content.

## 11. Explicit non-V1

Not V1: direct or multiple relay transport endpoints, Authority
transfer/rotation, historical import/backfill, open/edited Sessions, partial
replication, mixed-version compatibility, LCM Summary replication,
Project-wide/global packages, automatic conflict resolution, device-authorized
Team actions, any Operator/support recovery bypass, server key escrow,
post-closure source mutation, or any change to Directed Hosted Cross-Identity
Sync.

Fixed interoperability vectors live at
`packages/shared/test-fixtures/personal-device-sync-v1.json`. They include
non-production source manifest/wrapper, two-stage group statement, membership
certificate, Key Bundle, tombstone, Package ACK, conflict resolution, recipient
envelope/rewrap, deletion-floor, replay, convergence quarantine, equivocation,
expiry, and AEAD/AAD cases. Tests recompute every committed signature and hash,
and reject altered wrapper, domain, duplicate member, Unicode, numeric,
undefined, zero-shared-secret, and envelope-AAD inputs. Implementations consume
committed expected bytes and outputs; tests must not generate expected
signatures, X25519 secrets, HKDF, or AEAD output at run time.
