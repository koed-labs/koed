# Personal Project association and selection records

This describes the configuration contract for tickets 12 and 13. Activation is
part of the Project cutover in ticket 16. The configuration journal is separate
from Captured Sessions, checkpoints, Memory, and Team authorization.

A Project association and its selection identifier belong to one Personal
Device Group and its owning User. Equal independently resolved repository
anchors allow ordinary clone recall; equality does not establish a configuration
association. A local checkout must explicitly accept an association before its
shared selection can affect discovery. Acceptance must identify the live local
checkout incarnation, rather than a path that a different checkout could reuse.

The signed plaintext record is `{ revision, signature }`. Its revision has
protocol `koed/pds-project-selection/v1` and
contains `groupId`, `associationId`, `selectionId`, `revisionId`,
`authorDeviceId`, `authorSigningKeyId`, `replaces`, and `operation`.
The operation is either `set` with one `anchorFingerprint`, or `delete`.
Identifiers are opaque and stable. Every operation has a unique revision;
`replaces` lists its causal parents. There is no ordering timestamp.

An Ed25519 signature covers the canonical revision JSON with the domain prefix
`koed/pds-project-selection/v1/revision` and a newline. The receiving runtime
must authenticate the author certificate in the exact Personal Device Group,
verify the signature, and use encrypted PDS transport for the record. These
configuration operations must travel without waiting for Conversation capture.
Neither repository fingerprints nor plaintext configuration belong in relay
metadata. The journal repository accepts only previously verified records; it
does not grant local checkout acceptance when importing them.

The local journal retains every revision, including deletion records. It binds
one stable selection identifier to each association. Revision identifiers cannot
be reused, and causal parents cannot belong to another association. Replayed
records have no new effect. A record delivered before its parents leaves the
selection unresolved until the required history arrives. Cycles are rejected.

Current revisions are the causal heads: revisions that no retained operation
replaces. One set head selects its anchor. One delete head removes the shared
preference and resumes ordinary repository detection. Multiple heads remain a
conflict, including set/set operations choosing the same anchor and set/delete
operations. Arrival order and device clocks cannot choose a winner.

Local authoring and conflict resolution run in a transaction that rechecks the
exact heads the User reviewed. The new revision must replace all those heads.
A competing revision arriving before this transaction causes a stale-review
error. A genuinely concurrent revision arriving afterward remains a conflict;
the resolution cannot erase an edit it did not review. Re-creation after deletion
must explicitly replace the deletion head.

For an accepted association, a selected anchor must occur among the checkout's
current normalized portable remotes. Remote renaming and duplicate normalized
URLs do not change anchor equality. Missing anchors and conflicts leave discovery
unresolved. A local explicit selection retains precedence. Removing a local
override differs from deleting the shared selection. None of these configuration
operations reassigns existing sessions or changes a Team snapshot.

The API signs locally authored revisions through the private PDS key provider.
Association controls use the existing PDS browser or local Desktop governance
authentication; API Tokens cannot accept associations or author revisions.
The owner-scoped capture lookup returns only the accepted association identifiers
and current selection or conflict. It does not return the revision journal.

The existing PDS Worker transports selection records through a separate durable
outbox. Local authoring records the revision and outbox entry in one transaction
and wakes `koed_pds_local_sync`. Delivery observes the existing publication pause,
uses durable retries after failures and restarts, and acknowledges imported
configuration without creating a Session or semantic artifact. Rewrapping for
the current recipient set preserves the signed revision bytes.

Local acceptance is stored separately by owner, local profile identity, and
checkout incarnation. Incoming records never create acceptance rows. Reusing a
path with a replacement checkout cannot inherit the previous checkout's
association. Forgetting local acceptance leaves the shared causal journal and
its deletion records intact.

Each publication uses a fresh random transport identifier. Its package identifier
is SHA-256 of the UTF-8 string
`koed/pds-project-selection/v1/delivery\0<record-hash>\0<transport-id>`;
`\0` denotes a zero byte. The record hash is SHA-256 of the canonical signed
record, encoded as base64url. The source manifest hash remains that record hash.
The receiver checks both identifiers after transport and author authentication.
A renewed transport can therefore recover from an expired earlier delivery;
the configuration journal deduplicates the unchanged revision.

When the authenticated recipient epoch changes, the author republishes its
retained configuration revisions, including acknowledged deletions. Publication
requires the current local Group epoch, and preserves every signed revision byte.
A newly admitted or formerly offline device receives the causal history it needs
without resurrecting a superseded preference or requiring Conversation capture.

## Desktop use

Open the Project dropdown and select a folder. The folder card shows its
repository, path, inline reveal action, and Advanced controls. Each control
uses that folder's local Project and checkout identity. Changing folders requires
returning to the Project dropdown.

Open Share anchor across devices. Use existing lists available shared choices.
Select one and choose Link folder to accept it for this checkout. Share new
shows this folder's portable remotes. Choose Share and link to publish a choice
and link this checkout. Pair Personal devices before either action. Matching
repository addresses do not link folders automatically.

Save changes publishes a new choice for all linked folders. Remove shared choice
removes that shared preference and preserves its deletion revision. Unlink this
folder removes only this checkout's local acceptance. Choices made for one folder
stay in place and take priority over shared choices. Existing Conversation
assignments do not move. How sharing works contains these additional details.

For a conflict, review every current choice or deletion and its authoring device.
Choose Resolve or Resolve by removing shared choice. Even changes that select
the same repository require review. If another revision arrives before the
transaction, Desktop refreshes the review and requires another explicit choice.
It does not resubmit automatically. Share again explicitly replaces a deletion.
Incomplete history disables shared edits until inspection succeeds. Refresh
shared choices reloads the current state.

Repository anchor offers Automatic and Choose for this folder only. Automatic
follows an accepted shared choice or uses Git detection. Save anchor records the
chosen mode for new Conversations. Review previous assignments provides a
separate, explicit review for older Conversations. Repository controls require a
live local checkout. Historical imports keep their existing migration cutoff.

Desktop uses its Personal API Token for the bounded repository-selection lookup,
including when the User opens sharing before pairing devices. Device-group
inspection and shared configuration changes use the separate local Desktop
credential. The lookup does not grant authority to change shared configuration.

Accepted quiet checkouts refresh through the local Personal API when Desktop
loads Projects or inspects an association. Capture and recall discovery look up
the current accepted selection before choosing an anchor. The local catalog stores
that a checkout requires this lookup; the database remains authoritative for the
owner's acceptance and current causal state. A failed lookup defers discovery.
A local explicit choice takes precedence and does not require this lookup.
The owner inspection API returns current heads, while the journal retains complete
causal history.
