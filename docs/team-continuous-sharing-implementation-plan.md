# Team continuous sharing: production implementation plan

The User accepted the operational alpha on 21 October 2026 after manual testing.
The [production tickets](../tickets.md) record the completed local acceptance.
The [alpha tickets](archive/2026-10-21-operational-alpha/tickets.md) and
[alpha plan](archive/2026-10-21-operational-alpha/implementation-plan.md)
preserve the completed milestone. The
[original Package 2 plan](archive/2026-10-21-package-2/implementation-plan.md)
preserves the engineering design and its resolved decisions.

## Delivery sequence

PROD-01 is locally complete. Its focused evidence covers the conflicting source
locks, independent concurrent admissions, direct and rule recovery, and denial
after authority changes. See the [validation record](team-continuous-sharing-validation.md#prod-01-activation-contention).
P2-10 is locally complete: the retained owner/source/Workspace veto, reviewed
Desktop action, durable delivery and access denial pass focused checks.
P2-11 is locally complete: fresh native restoration catches up eligible active
rules and preserves paused, stopped, removed-member and revoked snapshot boundaries.
PROD-02 is locally complete: normal explicit preview prepares live tails and
wakes configured AI Client synthesis; a later turn reached Team publication.
PROD-03 is locally complete: a separately reviewed direct snapshot reuses a rule-created
contribution, stays fixed during later rule updates, and stops independently.
PROD-04 is locally complete: operation failures take precedence, preparation stages
and source revisions are explicit, and owner navigation preserves the source title.
PROD-05 now has matching final Desktop, Team and embedding artifacts with all
75 current migrations. Fresh standard-Compose startup, full-service restart,
semantic readiness and encrypted restoration pass. Earlier packaged core setup
and approved fixture enrollment remain valid within their recorded scope.
The final native enrolled-device journey and current-state restore now pass.
Interactive approval was available during the resumed run. Resumed native startup exposed library
links into a replaced app bundle. The installer now preserves relative links,
and the rebuilt native package starts its embedding model successfully.
Matching artifacts include this fix. P2-13 is locally complete through
CLI, API and repository evidence.
P2-14 is now locally complete with the same security boundaries. The backend
now binds exact receiving-device native approval to the rule scope and source
proof, transfers publisher authority and fence atomically, retains active/paused
state, and preserves original source sync provenance for later publication.
Native approval, durable transfer and fresh receiving history installation now
pass focused checks. Durable receiving reconciliation now includes existing Team
members absent from that receiving selection, retaining missing evidence as
pending. Interactive owner controls now pass focused UI, route and renderer build
checks. The approved native Git Anchor transfer, later source update, encrypted
Personal replication, former publisher denial and contribution identity checks
now pass on matching builds. Same-build encrypted restoration preserves that
committed transfer state and later publication, with authorized and denied reads.
Previously published sources removed automatically by selection can now re-enter
without a new source origin or receiving upload. Team prepares the current
candidate from encrypted source cache and original sync mappings, checks the
unchanged native-approved future scope, and creates a fresh consent on the same
destination grant. Durable delivery distinguishes retained admissions and recovers
exact receipts without queuing source uploads. Pending activation rechecks
original credentials, policy and Workspace boundaries. Stale retained admissions
can replace obsolete pending work after fresh checks; bounded local observation
continues until Team initializes the member. Healthy pending work stays intact.
Originally native unresolved admissions now continue using their accepted native
candidate and original source cache. First-destination creation and initial
source policy creation stay within that approved scope; explicit cancellation,
missing source revisions and current restrictions remain vetoes. The native Git
Anchor two-device journey and the combined controls in PROD-06 pass.
Matching final builds pass.

Extended recovery in P2-13 is locally complete, unlocking publisher takeover
in P2-14.
P2-09A and P2-09B are locally complete. Focused publication, authorization,
approval, delivery and editor checks pass; both owner editors are restored.
P2-12 is locally complete: reviewed snapshot conversion preserves the fixed
publication until continuous sharing is ready, rejects stale and duplicate
requests, and retains independent reasons and destinations.
P2-13 now includes actual Team publication and read-back after missing history,
restart, membership changes and later turns. Approval expiry still requires a
fresh review; exact committed receipts remain recoverable.
The twelve implementation tickets list only genuine unfinished blockers.
PROD-06 is locally complete, with unavailable deployment qualifications explicitly
disposed in the [candidate status record](team-continuous-sharing-release-candidate.md).

## Repeatable acceptance procedure

The combined native journey requires two authorized Personal devices with usable
protected credential storage. Keep secure storage enabled. If macOS requests
approval, let the User complete that operating-system decision. When the User is
away, continue build, service, restart and restoration work that does not depend
on that approval; leave the affected native checks explicitly unverified.

Use the [owner workflow](shared-memory-owner-workflow.md),
[runtime instructions](running-koed.md), and
[server Compose instructions](../examples/server-compose/README.md) for supported operations.
Use the same source state on Desktop and Team Backend.
Record artifact identities before the journey.

1. Enroll both Personal devices through the normal device approval flow.
2. Sign in as two synthetic owners with access to two test Workspaces.
3. Exercise Conversation, Git Anchor, Folder, and Project rules through Desktop.
4. Record each result in the [validation record](team-continuous-sharing-validation.md).
5. Restore the resulting data through the isolated procedure described below.

The accepted combinations have these required outcomes:

| Operation                                                                  | Required outcome                                                                     |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Existing and future selection members                                      | One logical contribution per destination, with exact approved source identity        |
| Both snapshot and rule creation orders                                     | Independent reasons remain inspectable and stop independently                        |
| Explicit snapshot conversion                                               | Fixed access persists until approved continuous publication replaces it              |
| Pause, resume, stop and detail changes                                     | Published access and pending acknowledgment match the selected operation             |
| Restrictive and broader content policies                                   | Restrictions apply immediately and increases require fresh approval                  |
| Workspace exclusion during retry, LCM work, policy processing and recovery | Every sharing route remains denied in that destination                               |
| Reviewed exclusion removal                                                 | Eligible active rules catch up while paused and stopped rules retain their state     |
| Publisher takeover and former-publisher replay                             | The receiving device continues under exact authority and former writes remain denied |
| Missing and later available source evidence                                | Missing evidence remains pending and cannot authorize guessed sources or removals    |
| Private, revoked, disabled and retained sources                            | Reads, recall, evidence and expansion enforce current authority                      |
| Separately authorized Conversation Source Access                           | Sharing controls preserve the independent source capability and its revocation       |

For restoration, retain the same encryption configuration and quiesce the test
deployment. Follow [hosted backup and restore instructions](hosted-backups.md).
Use an isolated disposable target database. Never point `restore-smoke` at the
running source database. Preserve consent, revocations, retention, independent
rule reasons, publisher fences and publication identities. Exercise authorized
reads and denial boundaries after restoration.

Record unavailable deployment evidence separately. WorkOS identity, remote
staging, portable native assets and release signing remain unavailable locally.
The local package uses an ad-hoc development signature. Local fixture success
does not establish those deployment results. Local production release-candidate acceptance is complete. Actual release
qualification still requires those unavailable inputs. Publication requires a
separate decision.

## Candidate assembly and operator handoff

Build Desktop and Team from the same source state with frozen dependencies.
Use the documented [native asset input](native-runtime-assets.md) for Desktop:

```bash
pnpm install --frozen-lockfile
KOED_NATIVE_RUNTIME_SOURCE_DIR=/path/to/native-runtime pnpm desktop:package:mac
pnpm --filter @koed/desktop verify:package:integrity:mac
docker build -f packages/koed-server/Dockerfile -t koed-server:rc .
```

Run heavy builds sequentially. Check Docker disk headroom before building and
before backup. The local validation encountered database shutdown and WAL
recovery after build cache exhausted Docker's disk. Reclaim unused build cache
or explicitly identified superseded artifacts; preserve current images,
databases and model volumes. Verify database readiness before restarting services.

Record the immutable Team image ID, Desktop package integrity result, component
and schema identities, platform, signature type and source state. The latest
identities are in the [validation record](team-continuous-sharing-validation.md#refreshed-artifact-and-restoration-checkpoint).
An `app.asar` hash alone does not identify the API and Worker packaged outside
it. Current schema acceptance covers 75 migrations ending at
`0074_yellow_nightmare`. Mixed components and historical restore are outside scope.

Retain the deployment's encryption configuration with its encrypted backup.
Quiesce writes for an exact restore comparison, restore into a separate disposable
database, and check authorized reads and current denial boundaries through the
restored service. Return the source deployment to its original database after
the check. The completed restore covers native overlapping reasons, stopped
Project state, committed publisher transfer and later source publication. Repeat
the final state check if later acceptance actions change that data.

The handoff must name each unfinished native check and each unavailable deployment
check. Developer-fixture authentication does not qualify WorkOS. An ad-hoc macOS
signature and locally staged Homebrew assets do not qualify portable signed
release artifacts. Keep the current secure-storage behavior while native
approval is unavailable. The User's decision to omit a changeset remains in
effect. Build and acceptance evidence authorize no release, push, PR, merge or
external deployment.

## Preserved boundaries

Retain P2-01 through P2-08 and the accepted alpha corrections. Keep Personal
Projects private as sharing selectors. Preserve consent, privacy, retention,
Workspace Access, and independent sharing reasons across every enabled operation.
The [decision record](team-continuous-sharing-preparation.md) remains applicable.

Keep synthesis in the connected AI Client. Reuse existing transaction owners,
publication processing, and durable delivery. Add no backend LLM synthesis or
Team collections. Coordinate current contract changes across the affected components.

Target fresh installations with matching current components. Legacy datasets,
historical database layouts, old protocols, mixed-version operation, and historical
upgrades are out of scope. Bring forward resolved principles and designs.
The current tickets supersede historical compatibility requirements.
Consolidate experimental schemas when this materially simplifies delivery.
Preserve unrelated data and backups. Do not create a separate schema-cleanup project.

Keep current-build persistence, restart, recovery, and backup restoration.
Fixed snapshots, explicit conversion, and publisher takeover remain production
behaviors. Their acceptance uses data created by the current build.

Keep the alpha's reviewed-stop recovery evidence within its actual scope.
P2-13 must explicitly resolve fresh offline-stop initiation. Do not assume that
an approval reviewed online establishes a new offline approval capability.

## Evidence and completion

Record results in [Package 2 validation](team-continuous-sharing-validation.md).
Keep remaining implementation work in [TODO.md](../TODO.md). Reuse valid evidence.
Run focused checks for changed behavior and permission boundaries. Run heavy
builds sequentially and broad checks at meaningful integration checkpoints.
Do not expand a harness without a concrete missing acceptance check.

PROD-06 collects combined behavior and security, current-build operation, and
release-candidate evidence. It includes the two-owner, two-Workspace, two-device
native journey and combinations of features delivered by independent tickets.
Backup restoration uses the same build and matching encryption configuration.
Record unavailable staged evidence separately from successful local checks.

Completing this plan establishes readiness for a production release candidate.
The User's decision to omit the changeset remains in force for this work.
Push, PR creation, merge, external deployment, and release publication remain
separate actions that require authorization.
