# Personal Device Sync Protocol V1

Status: Normative V1 profile for [ADR 0012](adr/0012-symmetric-replicated-personal-memory.md).

This document freezes Personal Device Sync (PDS) V1. It is implementation
input, not an implementation. No current production API, canonical-JSON helper,
or RSA recipient-envelope code implements this protocol. In particular, existing
directed [Cross-Identity Sync](self-hosted-to-hosted-sync.md) uses a distinct
RSA-OAEP target-envelope contract and must not be reused as PDS V1.

## 1. Scope and trust boundary

PDS has one protocol identifier: `koed/pds/v1`. A receiver accepts only that
exact identifier. It rejects absent, older, newer, alternate, or negotiated
versions. No mixed-version window, downgrade path, or protocol fallback exists
in V1.

PDS replicates all **eligible future closed Captured Sessions** to every active
Personal Device Group device. It is relay-required. Each device remains a
symmetric local replica: capture, materialization, Projection, embeddings, and
Recall are local. Relay outage never stops local capture or Recall of already
materialized Memory.

PDS is not PostgreSQL replication, Team replication, a Personal Hub, or
Cross-Identity Sync. Directed hosted Cross-Identity Sync remains a separate
one-way protocol between distinct identities/deployments. Its selected-source,
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

## 2. Encoding and signed bytes

All protocol JSON is RFC 8785 JCS. Signatures cover UTF-8 bytes only. JSON
objects reject duplicate members, non-finite numbers, non-JCS input, unknown
members, and non-canonical reserialization. Binary fields use unpadded base64url
unless a field explicitly says `hex`; IDs are printable opaque ASCII and never
local paths.

Integers that can exceed JavaScript safe range are canonical decimal strings.
Timestamps are RFC 3339 UTC strings with exactly three fractional digits, for
example `2026-07-15T00:00:00.000Z`.

A signing input is exactly:

```text
UTF8("koed/pds/v1/" + recordType + "\n") || UTF8(JCS(recordWithoutSignerWrapper))
```

Permitted `recordType` values are `group-statement`, `membership-certificate`,
`source-manifest`, `transport-envelope`, `tombstone`, `tombstone-ack`, and
`conflict-resolution`. A signature valid for one type is invalid for every
other type. To make `recordWithoutSignerWrapper`, remove whole signer wrapper, including
key ID and signature: `authorization`, `authority`, `authoritySignature`,
`originSignature`, `servingSignature`, or `signature`, as applicable. Group and
tombstone authorization removes both `authorization` and absent-at-signing-time
`authority`; Authority countersignature removes only its `authority` wrapper
and retains verified authorization wrapper. Group/tombstone authorization uses
`group-statement`/`tombstone` domain; Authority countersignature uses same
record type. Authority wrappers use `keyId`; device/recovery wrappers use
`signerKeyId`.

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

### CAS group log

`GroupStatement` has exact required fields:

```json
{
  "protocol": "koed/pds/v1",
  "groupId": "opaque-group-id",
  "sequence": "1",
  "previousHead": null,
  "kind": "genesis|add-device|revoke-device|rotate-epoch|recover|tombstone|resolve-conflict",
  "issuedAt": "2026-07-15T00:00:00.000Z",
  "authorization": { "signerKeyId": "...", "signature": "..." },
  "body": {},
  "authority": { "keyId": "...", "signature": "..." }
}
```

`body` has exactly one shape by `kind`:

- `genesis`: `authorityKeyId`, `authorityPublicKey`, `recoverySigningKeyId`,
  `recoverySigningPublicKey`, `recoveryKemKeyId`, `recoveryKemPublicKey`,
  `initialEpoch` (decimal string), `initialKeyCommitment`, and
  `recoveryKitHash`;
- `add-device`: `deviceId`, `deviceSigningKeyId`, `deviceSigningPublicKey`,
  `deviceKemKeyId`, `deviceKemPublicKey`, and `operationFamilies`;
- `revoke-device`: `deviceId`, `reasonCode`, and `revokedAt`;
- `rotate-epoch`: `previousEpoch`, `nextEpoch`, and `nextKeyCommitment`;
- `recover`: `replacementDeviceId`, replacement signing/KEM key IDs/public
  keys, and `recoveryKitHash`;
- `tombstone`: `tombstoneHash` and `floorId` supplied in signed tombstone;
- `resolve-conflict`: `sourceFingerprint`, `selectedClosureHash`, and
  `resolution` (`select` or `distinct`).

Every key ID is opaque ASCII; public keys are raw 32-byte base64url; epoch and
sequence values are canonical decimal strings. `operationFamilies` contains
only `pds_relay`. `sequence` increments by one; `previousHead` equals SHA-256
of prior fully countersigned statement. Client submits `previousHead` as
mandatory CAS value.
Authority atomically accepts only current head and sequence + 1, validates
active-device or recovery-root authorization, then countersigns. CAS conflict
returns current signed head; client rereads and makes a new explicit action. It
must never silently retry a transition against changed state.

Authority signs a membership certificate only for group-log active device key
material. It has exactly `protocol`, `groupId`, `deviceId`, `deviceSigningKeyId`,
`deviceSigningPublicKey`, `deviceKemKeyId`, `deviceKemPublicKey`, `epoch`,
`operationFamilies`, `statementSequence`, `statementHead`, `issuedAt`,
`expiresAt`, and `authoritySignature` (`keyId`, `signature`).
`authoritySignature` is omitted from its `membership-certificate` signing bytes.
Maximum lifetime is 7 days. Receiver permits 5 minutes clock skew for
`issuedAt`, requires `now < expiresAt` exactly, and rejects a certificate whose
stated lifetime exceeds 7 days. Cached certificate expiry blocks relay
send/receive; local capture/Recall continue.

A membership/log fork, same sequence with different bytes, invalid prior hash,
or mismatched Authority countersignature is authority equivocation. Device
enters **equivocation freeze**: no enroll, revoke, recovery, key delivery,
package upload, download, serve, or tombstone action. It continues local capture
and Recall. Freeze clears only after a valid group-authorized,
Authority-countersigned resolution statement extends one verified head.

## 5. Closed Captured Session source package

Only future Sessions closed after PDS policy activation are eligible. V1 sends
one immutable closed-Session package per source origin. Open Sessions,
historical backfill, Project-wide/all-memory packages, mutation after closure,
and partial device placement are non-V1.

`source-manifest` is encrypted content and has exactly these fields; unknown
fields are rejected:

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
  "sourceClosureHash": "base64url-sha256",
  "contentEpoch": "3",
  "closedSession": {
    "closed": true,
    "sourceAdapter": "adapter-id",
    "sourceAdapterVersion": "version",
    "captureMethod": "supported_capture_hook",
    "sourceCreatedAt": "2026-07-15T00:00:00.000Z",
    "sourceClosedAt": "2026-07-15T00:00:01.000Z",
    "observedClosedAt": "2026-07-15T00:00:02.000Z"
  },
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
Payload plaintext is exactly UTF-8 JCS of complete source manifest, including
`originSignature`. `originSignature` is excluded only for source-manifest hash,
package-id preimage, and source-manifest signature bytes as defined in section 2.

Closure is contiguous ordered raw source observations with ordinals `0..n-1`,
no gaps, no duplicate ordinal, and no omitted source record from Session start
through terminal close evidence. Raw source records retain original source
payload bytes plus source-native identity, source order, and observation
provenance. Receiver verifies raw hash for every record, ordinal contiguity,
closure hash, manifest ID, and origin signature before materialization.

First slice excludes **all** derived data: Memory Events, Memory Nodes,
Projection rows, embeddings/vectors, indexes, LCM Placeholders, LCM Summaries,
titles, evidence, and local processing state. Source-owned LCM Summary sync is
deferred non-V1. Each replica runs local Projection and local LCM Summary
Service after source validation.

Equal source fingerprint plus equal closure hash converges to one logical
Memory identity while preserving both origin observations. Equal fingerprint
plus different closure hash is **quarantine**: store redacted provenance,
exclude all conflicting variants from Projection and Recall, and never choose
last writer. Only valid group-authorized/Authority-countersigned
`resolve-conflict` has exactly `protocol`, `groupId`, `sourceFingerprint`,
`candidateClosureHashes`, `selectedClosureHash`, `resolution` (`select` or
`distinct`), `statementHead`, `issuedAt`, `authorization` (`signerKeyId`,
`signature`), and `authority` (`keyId`, `signature`). `select` requires exactly
one selected candidate; `distinct` requires `selectedClosureHash: null`. Sources
without trustworthy stable native ID remain distinct.

## 6. Encryption and recipient envelopes

Transport uses TLS and PDS end-to-end encryption. Source plaintext package is
encoded once, encrypted under random 32-byte content encryption key (CEK), then
CEK is recipient-enveloped for every active recipient. Re-serving device may
add valid recipient envelopes without changing signed source manifest, closure,
content ciphertext, or origin claim. Serving device signs its transport envelope
with its device signing key.

### Ciphertext

Payload uses AES-256-GCM with random 96-bit nonce. CEK must be generated by OS
CSPRNG and used once. Payload AAD is UTF-8 JCS of transport header excluding
`payloadCiphertextHash`, `payloadTag`, and `originTransportSignature`. It
includes exactly protocol, group id, package id, source-manifest hash, origin
device id, `contentEpoch`, total plaintext bytes, chunk count, and payload nonce.
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

`uint64be(epoch)` is unsigned eight-byte big-endian. Envelope CEK encryption is
AES-256-GCM using `wrappingKey`, CSPRNG 96-bit nonce, and JCS UTF-8 AAD:

```json
{
  "recipientEpoch": 3,
  "packageId": "...",
  "recipientDeviceId": "...",
  "senderDeviceId": "..."
}
```

Recipient envelope fields are exactly `protocol`, `packageId`, `contentEpoch`,
`recipientEpoch`, `senderDeviceId`, `recipientDeviceId`, `recipientKemKeyId`,
`ephemeralPublicKey` (raw 32-byte base64url), `nonce` (12-byte base64url),
`ciphertext` (32-byte base64url CEK), `tag` (16-byte base64url), and
`servingSignature` (`signerKeyId`, `signature`). It is signed under
`transport-envelope` with `servingSignature` omitted. Reject missing/unknown
fields, wrong lengths, recipient/key epoch mismatch, failed AEAD, stale
membership, or bad signature. Re-serving after epoch rotation preserves source
ciphertext/header and `contentEpoch`, then adds only a new valid
`recipientEpoch` envelope.

## 7. Relay, package, replay, and retention

Relay accepts only current valid membership certificate and signed transport
header. Header has exactly `protocol`, `groupId`, `packageId`,
`sourceManifestHash`, `originDeviceId`, `contentEpoch`, `plaintextByteCount`,
`chunkCount`, `payloadNonce`, `payloadCiphertextHash`, `payloadTag`, `expiresAt`,
and `originTransportSignature` (`signerKeyId`, `signature`). Signature bytes
omit whole `originTransportSignature` wrapper; `payloadNonce` is 12-byte
base64url, `payloadTag` is 16-byte base64url, and `payloadCiphertextHash` is
base64url SHA-256 of `payloadCiphertext || payloadTag`; `payloadCiphertext` is
concatenation of chunk `ciphertext` in ascending `chunkIndex`. Each chunk has
exactly `protocol`, `groupId`,
`packageId`, `chunkIndex`, `chunkCount`, `ciphertext`, and `chunkHash`. It sees
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
| outstanding encrypted bytes per sender |     2 GiB |
| retained encrypted bytes per group     |    10 GiB |
| compression                            | forbidden |

Relay retains undelivered package bytes for 30 days from accepted upload.
After every active intended recipient ACKs package id plus source-manifest hash,
relay deletes package bytes 7 days later. Redacted delivery receipt may remain
only through quota/audit retention. Retention expiry never changes local
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

Personal deletion tombstone has exactly `protocol`, `groupId`,
`logicalMemoryId`, `sourceFingerprint`, `closureHashes`, `tombstoneSequence`,
`statementHead`, `activeDeviceSnapshot`, `floorId`, `issuedAt`, `authorization`
(`signerKeyId`, `signature`), and `authority` (`keyId`, `signature`).
`floorId` is created by authorized device/recovery root using `K_tombstone` and
is bound by its signature before Authority verifies/countersigns it. Authority
never derives it and never holds `K_tombstone`. Tombstone is bound to logical
memory identity, source fingerprint, closure hash(es), group-log head,
monotonic tombstone sequence, and active-device ACK snapshot. It needs
active-device or recovery root authorization and Authority countersignature.
Authority alone cannot issue it. Tombstone has its own signing domain and is
immutable.

At tombstone creation, Authority snapshots exact active device IDs from accepted
log head. `tombstone-ack` has exactly `protocol`, `groupId`, `tombstoneHash`,
`deviceId`, `statementHead`, `ackedAt`, and `signature` (`signerKeyId`,
`signature`); signature is omitted from `tombstone-ack` signing bytes. Each
device signs ACK after local removal/quarantine of matching source and derived
representation. Tombstone full record remains until
all snapshot devices ACK, then for 30 additional days. Revoked-after-snapshot
devices remain required only if they were active at snapshot; a later
Authority-countersigned resolution may mark an irrecoverable device exception.

Authority stores opaque group-lifetime deletion floor:

```text
floorId = HMAC-SHA-256(K_tombstone,
  UTF8("koed/pds/v1/deletion-floor\0") || UTF8(logicalMemoryId))
```

It stores `floorId`, highest tombstone sequence, and signed tombstone hash, not
Memory plaintext, source fingerprint, raw Session ID, or keys. Floor cannot be
removed before irreversible group purge. On backup restore or new materializer,
device fetches/verifies group head and all applicable floors before accepting
package bytes; any package at or below tombstone sequence is rejected. Restore
never lowers local lifecycle high-water mark.

## 9. Project aliases

Project association is local grouping/search context only. It never grants Team
access or chooses a Workspace. PDS package can contain epoch-HMACed canonical
remote alias tokens, never raw paths/remotes:

```text
HMAC-SHA-256(K_project[e], UTF8("koed/pds/v1/project-alias\0") || UTF8(alias))
```

Canonical alias is normalized network host (lowercase, IDNA), namespace, and
repository name after stripping credentials, default port, `.git` suffix, and
transport spelling. Local-only paths have no alias.

Auto-match only when exactly one canonical alias token intersects and it maps to
exactly one local Project on each device, with no explicit deny/manual override
and no competing current/historical alias. Zero or multiple aliases, collisions,
forks, changed canonicalization, local-only Projects, or any competing Project
requires User confirmation. User override wins until removed.

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

Not V1: direct peer transport, historical import/backfill, open/edited Sessions,
partial replication, mixed-version compatibility, LCM Summary replication,
Project-wide/global packages, automatic conflict resolution, device-authorized
Team actions, any Operator/support recovery bypass, server key escrow,
post-closure source mutation, or any change to directed hosted Cross-Identity
Sync.

Fixed interoperability vectors live at
`packages/shared/test-fixtures/personal-device-sync-v1.json`. They include
non-production keys only. They cover source and group statements, signature
domains, key envelopes and rewrapping, replay, convergence quarantine,
equivocation freeze, tombstone restore, expiry, and AEAD/AAD failure.
Implementations must consume committed expected bytes and outputs; tests must not
generate expected signatures, X25519 secrets, HKDF, or AEAD output at run time.
