# Peer-online sync: development slice design

## Intent

Exercise single-origin Session checkpoint exchange and read-only replica
materialization between two isolated local databases without a running
Authority or Relay service. Either fixture can originate Sessions. This is a
development-only experiment, not proof of independently running installations,
network connectivity, offline Recall, or the complete peer-online profile. It
does not replace PDS V1.

## Approaches

1. **Direct checkpoint slice (selected).** Provision two test identities and
   exchange existing encrypted checkpoint packages directly through a strictly
   in-process test adapter, retaining existing verification and database
   materialization. This exercises the core data path without designing pairing
   first, but does not prove peer-governed membership or real deployment.
2. **Pairing and membership first.** Build admission and governance before the
   sync path. This gives a more realistic trust model, but delays testing the
   core data flow and depends on unresolved governance decisions.

## Scope and boundaries

- Use two isolated local databases and explicit ephemeral test identities,
  group secrets, and Authority-shaped test certificates. A test Authority
  signing key provisions certificates locally; there is no Authority service.
  This retains V1 package verification and does not establish decentralized
  membership or define the new profile's final trust model.
- Keep orchestration and delivery in-process and test-only, with no production
  configuration or network listener. This tests a delivery boundary, not network
  authentication, replay protection, or real reconnect behavior. Production
  transport authentication and replay protection remain required and unproven.
- Exercise existing checkpoint creation, encrypted package verification,
  retained-package state and database materialization paths. Never bypass
  certificate checks or simulate a replica by inserting an ordinary Session.
  Provision the group, policy, eligible source, completion evidence, recipient
  certificates, inbox and repository assignment state required by those paths.
  Use authenticated test lifecycle and deletion-floor fixtures bound to the
  test group and Authority head, including a nonempty floor; never substitute
  an unverified empty floor. Identify any dependencies replaced by the harness
  and report exactly which worker functions were actually exercised.
- Origin A delivers a checkpoint to B; B validates and durably materializes a
  read-only replica. Exercise a later cumulative checkpoint, repeat delivery,
  and reverse origin and receiver. Verify that normal source-item and source
  journal writes to replicas fail; local derived or assignment edits are not
  necessarily prohibited.
- Pause delivery to simulate an offline interval, resume it, and verify eventual
  application through explicit harness retries. This does not prove network
  reconnect, production durable scheduling or restart recovery.
- The harness reports success only after observing verified durable
  materialization in the receiver database, never merely after upload. Reject
  tampering, wrong recipients and inconsistent checkpoint history. A missing
  predecessor remains pending; the harness delivers the predecessor and retries
  the pending item. Redelivery of the same valid package must be idempotent.
  Do not invent or advance a production success cursor in this test slice.

## Explicit non-goals

No real pairing, membership changes, revocation, deletion propagation, internet
relay, backup recovery, migration, user-facing configuration, production release,
new durable mailbox, or automatic conflict recovery. Existing deletion-floor
checks remain enforced; the slice does not claim deletion convergence. No
acceptance or amendment of ADR 0012, ADR 0041, ADR 0045 or PDS V1 is implied.
The proposed ADR 0065 remains separate and unaccepted.

## Validation

Add focused tests demonstrating two isolated peers, each as origin and receiver;
verified package integrity and wrong-recipient rejection; duplicate handling;
cumulative append and missing/incompatible history; nonempty deletion floors;
durable success and source write protection; and retry after a simulated
offline interval. Test any
extracted adapter at its actual boundary, and document which service, capture,
projection, and network behaviors are not exercised. Run applicable targeted
tests, formatting, lint and typechecks; report any unavailable dependencies or
coverage limitations explicitly. The slice cannot be considered production-ready
until the omitted governance, deletion, security and recovery work is designed
and validated.
