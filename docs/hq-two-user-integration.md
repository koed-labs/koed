# HQ two-user integration

Run this contract against a disposable PostgreSQL 17 server with pgvector.
The PostgreSQL role needs `CREATEDB`; the test creates three randomly named
child databases, migrates them and drops only those children on exit. Never
supply production credentials or a production database URL.

```sh
pnpm build
KOED_HQ713_TEST_DATABASE_URL=postgres://user:password@127.0.0.1:5432/disposable pnpm test:hq-two-user
```

The command fails if its database prerequisite is missing. CI runs it as a
separate required step after the ordinary tests, including the new-HQ Native
companion under Xvfb. It uses a dedicated Vitest
entry so it does not repeat the package suites. Existing checks and coverage
remain required.

The Shared Memory repository suite also requires `CREATEDB`. It uses one
migrated template and a fresh database clone for each test. The configured test
database is used only to create and drop those owned databases; it is never
migrated or reset by that suite.

The fixture starts three production HTTP servers: one `team_self_hosted`
Team backend and a separate Personal backend for Alice and Bob. Requests use
real listening sockets, browser sessions, scoped device credentials and
owner-local Desktop credentials. Each human has distinct Personal-owner and
Team-principal account IDs, linked through the verified source identity;
tests do not rely on equal IDs across deployments. The fixture initializes synthetic identities,
verified deployment metadata and AI Client availability. Each source device is
enrolled through the actual Team challenge and browser approval routes, including
its verified Personal host signing key. Team creation,
invitations, Project association, source capture, consent, sharing and
lifecycle transitions go through production routes. It does not insert Share
Grants, consent receipts or member Project links to make a scenario pass.

Canonical owner LCM summaries and Curated assertions are synthetic input,
created with complete source links and normal encrypted payloads. A local
HTTP test driver supplies deterministic embedding and privacy-classifier
responses for this safe fixture content. Publication, sanitization,
authorization, retrieval and withdrawal use production services. These inputs
do not test model quality or replace a successful Team result.

The contract covers the two-user story in isolated service episodes. Each
episode starts fresh identities and databases so deletion cannot silently
reactivate an earlier member link:

1. Share a Project and accept its invitation with explicit summary disclosure.
2. Confirm each member's separate Personal Project and private HQ identity.
3. Recall an exact shared summary with Team citation and no transcript access.
4. Observe the real authorized SSE refresh signal after Bob creates a Work
   Item, reload Alice's current Team state and resolve simultaneous versioned
   edits. Shared Project events use the existing snapshot-recovery protocol;
   they do not send Personal Work Item payloads.
5. Dispatch the acting member's private Agent; expose only shared progress.
6. Make a chat private and deny subsequent Team recall.
7. Lose Team connectivity and preserve a read-only offline projection.
8. Delete a shared Project, detach Personal chats and freeze published coverage.
9. Restore Project metadata without restoring links or advancing frozen grants.
10. Resume an interrupted first-share copy without duplicating its Project.
11. Leave a Project or Team with the specified different access effects.
12. Share Curated Memory only after separate consent, with complete exact-Session
    provenance; acknowledge Team withdrawal before a Personal scope change.
13. Share Deck content while keeping progress and first-Again Me review private.
14. Refuse a last-owner leave before copying; revalidate ownership and resume
    interrupted copy-back without duplicate Personal content.

The Curated-sharing episode starts with the default restrictive policies. It
uses separate administrator Step-up operations to opt in the Team and Workspace,
then the exact source owner's separate Curated Step-up for an explicit
Workspace grant over one Captured Session. Project-bound policy grants remain
summary-only; their authorization is not expanded by this test. It proves that active,
frozen and revoked summary grants retain their previous scope and lifecycle.
No test bypasses the policy or seeds Team capability rows. Curated source content
crosses only as a signed derived artifact after the exact owner consent; the Team
fixture has no copy of the Personal canonical Curated tables.

Initial source delivery binds to the accepted Team Pending Share and its exact
locally retained reviewed preview. The Team creates the source-owner consent
record during activation, after source delivery; an initial upload cannot
depend on a local copy of that later record. Continuous delivery rechecks the
current Team grant and Pending Share, and the Team receiver checks the actual
consent before accepting an update.

An additional owner chat-deletion case confirms its exact grant freeze,
retained Team recall and exclusion of later Personal capture from that grant. The cross-user post-freeze
case complements the existing Team repository tests for atomic advancement
races, independent grants, expiry and revocation; it does not replace them.

The negative cases include source-owner consent, automatic-policy transcript
denial, Me and mixed-session Curated exclusion, and denial after departure.
Managed citation tests use actual runner credentials and a live command lease,
persist aliases from multiple recalls in one turn, reload them and reauthorize
source details after revocation. Runtime selector tests use the production task
coordinator, scheduler, local-edge routing and HTTP retrieval. Their local AI
Client test driver supplies deterministic answer wording from retrieved
fixture evidence; it does not call a backend LLM or test model quality.

For a local desktop visual review, set `KOED_HQ713_DESKTOP=1` and
`KOED_HQ713_DESKTOP_OUTPUT` to an owned evidence directory when running the
same command. This companion loads the production new-HQ shell,
sidebar, Project view, Share sheet, Now invitation card, typed preload and shared
Project store in Electron. The disclosure checks use a fresh Personal Project
and a separate live pending invitation. Collaboration commands use the production
Desktop transport and an owned broker process for each participant.
The fixture reuses each browser-enrolled Team connection without starting another
enrollment. A test-only adapter supplies the read-only invitation authority URL
from the main process's verified active backend registry, after matching the
live snapshot's backend and Personal owner. All command results and business
state still come from the production broker and listening APIs.
Its IPC handlers call the listening Personal and Team APIs with credentials
held in the main process. It captures both users' desktop views for comparison
with the approved design. It is a focused HQ component integration entry, not
a launch of the obsolete UI or a claim about model execution. The local service contract can run without the Native companion; CI requires
both. This does not replace the existing Desktop browser checks.

A reversible request fault gate produces actual HTTP 503 responses for selected
Team routes. It supplies no successful business response or authority. The
withdrawal scenario verifies that a failed Team acknowledgement leaves the
Personal scope and version unchanged, then retries through the durable
coordinator. Another gate drops one successful signed-update response after
Team commits it. The test requires a later monotonic generation, a matching
durable Personal acknowledgement, an unchanged capture cursor and no remaining
eligible copy of the withdrawn assertion. Evidence records contain IDs, versions
and counts, not credentials.

The first-share recovery cases use fresh Workspace scopes and preserve the
owner's original Personal content. They cover a lost reply across an actual
Personal API restart, exact-target mismatch, canceled delayed creation, deletion
before or after Personal confirmation, and Workspace access loss. A terminal
cancellation receipt fences delayed create/copy even if Team metadata is later
restored. A separate empty-policy case captures its first Session after Native
approval and runs the production Desktop future sweep through source preparation,
Team activation and teammate recall. The fixture establishes the verified checkout
before that review and deletes its pre-policy warmup Session through the normal
Personal lifecycle route. It then prepares the new capture before Session
creation and checks the immutable capture-time proof; it never backfills policy
bindings into an existing Session.

A rolled-back PostgreSQL serialization failure or deadlock before an external
activation callback is retried through the existing durable queue with a finite
budget. Every attempt rechecks current authority and the candidate manifest.
Uncertain external outcomes and unrelated errors retain the existing attention
path. The tests do not retry failed cases to turn the suite green.

Continuous publication processes the approved activation representation first.
An absent optional rollup does not block an available leaf summary. This does
not permit a representation outside the grant's source capabilities or consent.
Missing activation material, incomplete provenance, policy changes and
revocation still fail closed. A real PostgreSQL regression covers leaf-only
sources before and after the administrator opt-in.

The Project invitation regression tests cover reviewed acceptance after soft
deletion and acceptance racing deletion. The invitation keeps its exact Project
target, and deleted Projects cannot admit a recipient. Physical Project purge is
not implemented; any future purge must preserve that invitation target or
terminate pending invitations before removing their target records.
