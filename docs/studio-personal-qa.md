# Personal Studio end-to-end QA

Started 2026-10-03, Europe/Oslo. Branch: epic/ui-revamp.
The User authorized overnight review and repair of Personal Studio. Preserve
existing Projects, Conversations, local files, memories and Agent work. Do not
push or perform external GitHub writes. The User cannot approve Keychain or
provider sign-in until returning. Reuse the running Desktop and live local
backend; use isolated browser/renderer fixtures for mutations.

## Acceptance checklist

- Settings opens and scrolls; providers show actionable, accurate configuration.
- GitHub connection reuses supported existing access; pending actions terminate
  with a clear success, error or sign-in instruction.
- Project discovery and provider filters show justified rows and actual nested
  Conversations. Explicitly registered empty Projects remain valid.
- Conversation labels distinguish active work from an idle/resumable execution.
- Project and Conversation removal, failed saves, Undo and refresh work without
  affecting files, history, memories, sharing or running work.
- Agent creation, role suggestions, cloning, retirement filters and activity work.
- New chat selects a usable provider/model; send, streaming, continuation,
  history, drafts and errors have observable outcomes.
- Project moves and retained-workspace controls preserve approved semantics.
- PR navigation, Build history and notification settings use existing contracts.
- Personal navigation remains usable with the Team backend unavailable.
- Desktop packaging includes the native bridge and runtime assets. A Keychain-
  blocked restart is recorded as an environment gate, not a passing check.

## Evidence policy

Maintain findings, fixes and results below. Record real backend/provider checks
separately from synthetic browser coverage. One final integrated acceptance
pass follows the fixes. No repeatedly expanded whole-repository audit.

## Initial reported defects

| ID     | Report                                                              | Status                                                              |
| ------ | ------------------------------------------------------------------- | ------------------------------------------------------------------- |
| PQA-01 | Connect GitHub waits indefinitely and existing access is not reused | Fixed; client and synthetic browser checks pass                     |
| PQA-02 | Unexplained empty Project folders                                   | Fixed runtime-ID grouping; explicit empty Projects remain valid     |
| PQA-03 | Idle Conversations misleadingly labeled Running                     | Fixed authoritative activity mapping; build and focused checks pass |

## Recall

Koed Memory Answer failed its resource budget and returned no reliable evidence.
Explicit User decisions and repository contracts remain authoritative.

## Retired side-panel launch correction

A reviewer targeted the generic application name `Koed`. macOS selected the
retired installed Tauri app at `/Applications/Koed.app` (executable
`koed-desktop`, bundle `ai.koed.desktop`). That process was closed.

The User requested removing that side panel from the repository. The
`epic/ui-revamp` tracked tree already contains no `src-tauri`, Cargo manifest,
Tauri packaging or `koed-desktop` launch entrypoint. The source in the separate
`/Users/jacobo/Coding/koed` checkout on `main` was left intact: it is an older
checkout, not the branch being delivered. The installed obsolete app was not
uninstalled. Shared Electron services and the Studio menu-bar support remain.

QA must target the exact verified Studio package path and loopback URL. Never
launch or inspect the generic app name `Koed`, use `open -a Koed`, or activate
`/Applications/Koed.app` to review this branch. Root owns live GUI checks;
workers use source and isolated tests.

## Chat continuation and Build history corrections

Saved Conversations now restore their exact AI Client instance along with
model, effort and access. The composer accepts that identity whether it is the
only advertised client or one of several offering the same model. It does not
silently select another computer when the original client disappears. Four
focused rendered-composer regressions passed, including hosted catalog IDs.

Build history responses now check the selected Job and request sequence before
applying details or errors. The periodic runtime refresh also uses the current
selection. This fixes a code-confirmed stale response race; a provider-backed
live multi-Job switching check has not been performed during this overnight
pass.

## Browser and live API evidence

The maintained synthetic browser suite initially passed 30 of 35 checks. Three
PR failures used the wrong fixture account name and expected Connected before
explicitly selecting the discovered account. Those assertions were corrected;
the three PR cases then passed. The Team mention test constructed a message
locator before the asynchronous response handler supplied its ID; it now waits
for the response ID. That case and the initial Home owner-change case passed
in their focused follow-up (2/2). The initial Home failure showed Loading at
the five-second assertion during concurrent source edits; its exact cause was
not established. These are synthetic contract/browser results, not live GitHub
or provider execution.

The existing verified Studio package's real local gateway returned HTTP 200
for Home, registered Projects, local conversations and owner removal
preferences. No user records were changed by this read-only check.

## GitHub reuse boundary

Existing authorized GitHub CLI accounts on the selected computer are reused
through an explicit account selection. AI Client sign-in or the presence of a
GitHub plugin alone does not prove GitHub authorization; Studio never extracts
provider tokens. Adding an account uses the separate Sign in action. Failed
discovery stays visible as an error. Initial operation and CSRF requests have
a 20-second deadline; accepted-operation polling has its existing 180-second
cap. Connection status only changes after confirmed runner results.

## Overnight limits

The maintained UI suite uses isolated synthetic APIs, and existing-package
reads use the real local authority. No fresh provider prompt, external GitHub
write or new sign-in was issued during this pass. No fresh Desktop restart was
attempted while the User could not approve Keychain. A rebuilt artifact and
packaging checks do not establish a successful fresh native startup.

## Final build and packaging

Studio typecheck and production build passed after fixing the declaration order
and native TypeScript test-import annotations. API server build, Koed-server
build, Electron shell compile and sandboxed preload bundling passed. The new
package is:

`apps/desktop/release/personal-qa-final/mac-arm64/Koed.app`

Runtime staging includes current API and migrations, gateway, Studio static
assets, PostgreSQL and llama.cpp. Native bundle staging and required-file checks
passed. Deep strict codesign verification and the macOS package verifier
passed. The package was not launched. The current new Studio instance remains
visible; the old installed Tauri process and the isolated QA browser were closed.
The temporary inspector endpoint was also closed.

Focused results: Project/Home/gateway tests 42/42; API runtime route 1/1;
composer restoration 4/4; removal and provider-settings components/clients
17/17; GitHub and authenticated proxy/gateway tests 35/35. Some route cases
overlap between runs, so these numbers are not a unique aggregate test count.
The maintained browser scenarios all obtained a passing result across the
initial run and targeted follow-ups, as described above. This does not assert
that all live end-to-end provider flows were exercised.

No changes were pushed. Remaining attended checks are a fresh launch of this
exact package, approval of any genuine Keychain prompt, real GitHub account
reuse and a disposable provider Conversation continued after reopening.
Build-history stale response guards passed compilation/source review; a live
multi-Job selection check remains recorded above.

## New Chat Project sidebar correction — 2026-10-04

The User reported 19 Project folders, repeated names and no contained
conversations. Earlier diagnostic counts described registered metadata only and
did not establish the displayed tree. Read-only inspection of the actual
Desktop window at `/?chat=1` confirmed it used StudioSidebar's fallback folder
selector, which only nested managed executions and omitted discovered provider
conversations. This was a separate gap from global catalog pagination.

New Chat now uses the same LocalConversationBrowser as Home, including source
discovery, provider filtering, folder expansion, removal preferences and managed
continuation. Opening a folder automatically loads a bounded first batch if
its conversations are not in the currently loaded catalog pages. Project
selection for a new chat is preserved; opening an existing execution retains
its current Project. Different Project IDs are not merged by matching names.

Validation: production build and strict macOS signature verification passed.
An isolated browser running the updated source against the real local catalog
opened `my_frontend_app` from New Chat and displayed five conversation rows
nested beneath that folder plus Load more conversations. The Project context
in the new-chat URL updated correctly. This read-only check did not send
provider messages, alter removal preferences or delete records. Native runtime
reported no unfinished commands or uncertain turns before switching Desktop
to `release/personal-projects-final/mac-arm64/Koed.app`.

Native verification passed on the rebuilt package: one visible Studio window,
New Chat using the shared catalog, `my_frontend_app` expanded with five actual
conversation rows and Load more conversations. The folder was left expanded
for the User. New startup completed successfully. The temporary inspector,
isolated browser and source gateway were closed. No provider prompts, removal
writes, file deletions or GitHub push were performed.

## Archived Codex worktree Project duplicates — 2026-10-04

The User's screenshot was reproduced in the actual New Chat sidebar. The
archived Codex catalog assigns a Project ID to every session cwd, including
deleted `CODEX_HOME/worktrees/<id>/<project>` checkouts. For the reported
hexawar Project, 85 distinct archived cwd values refer to temporary worktrees;
the original checkout still exists. The live catalog's first 12 pages include
dozens of separate IDs with the same Project label. The correction must group
verified worktrees with their original repository, retain every source
conversation, and avoid merging unrelated physical folders by display name.
No folders, source history, memories or removal preferences are to be deleted.
Validation and rebuilt Desktop results will be recorded after implementation.

The original repository's origin changed from `jacobotoll/hexawars` to
`sknk-io/hexawars`. Grouping therefore also recognizes historical repository
URLs recorded by Codex sessions in a proven, existing main checkout. An
archived Codex worktree joins that checkout only when its exact repository URL
and folder name identify one root; ambiguous matching clones stay separate.
Live linked worktrees use Git's common directory. Canonical paths handle
symlinks and trailing separators; existing main Project and registered IDs are
preserved. No public API fields or database schema were added.

A metadata-only replay of all 132 real affected conversations passed across
two catalog pages: one Project, 132 unique source IDs, zero conversations lost
or duplicated. Metadata reads are bounded and cached per distinct cwd within
each scan. No provider invocation or data deletion was performed.

Scoped catalog tests passed 23/23; Koed-server typecheck and build passed;
`git diff --check` passed. Updated native package:
`apps/desktop/release/personal-project-duplicates-final/mac-arm64/Koed.app`.
Deep strict codesign verification passed. Before restart, all 14 managed
executions' latest commands were completed and the visible draft was empty.

Fresh native startup succeeded at `http://127.0.0.1:54857/` (root PID 78133).
The initial removal-preference read raced backend startup and displayed its
existing Retry state; Projects/removals APIs subsequently returned 200, and
the existing Retry action recovered the list. Record automatic recovery from
this startup race as a separate follow-up. After loading 18 older catalog
pages in the actual sidebar, the reported Project appeared exactly once with
five nested Conversations. Its Load more action increased visible nested
Conversations to ten without adding a second Project row. The folder was left
expanded for the User. The temporary inspector was closed. No changes pushed.

## Home recent history missing from sidebar — 2026-10-04

The two reported September27 Home entries are `How Rain Forms` and
`Koed Personal Agent context for this user turn only`. Both belong to stopped
Koed-managed Codex executions with no Project. Home matched them by session,
but the sidebar and captured-source matching accepted only active executions.
This hid their managed rows and incorrectly treated their provider sources as
captured-only conversations.

Stopped/failed/fenced managed history now remains in the sidebar, subject to
existing owner/removal/provider filters. Both entry points use the same
provider/session matching: one active execution takes precedence; otherwise
one terminal history execution may match. Ambiguous matches stay unresolved.
Terminal rows show their lifecycle status, and Home labels synthetic independent
Project IDs as No Project. Opening history does not start a provider or enable
Send on a stopped execution. Existing captured-only behavior is unchanged.

Scoped helper regressions passed19/19; Studio production build and targeted
ESLint passed (zero warnings after removing an unused import); diffcheck passed.
Updated native package `release/personal-history-sidebar-final/mac-arm64/Koed.app`
passed deep strict codesign verification. No backend contract or schema change.

Native verification is currently awaiting the User's Keychain approval. A
process sample of the exact new package (PID90215) shows the Electron main
thread blocked in `SecItemCopyMatching` / `SecKeychainItemCopyContent` during
startup. Inspector evaluation timed out; no native history-navigation pass is
claimed yet. Source regressions, build, lint and packaging checks above passed.

## Slow sidebar startup and stopped-chat continuation

The history package subsequently became responsive. A read-only native check
confirmed the How Rain Forms Conversation has nine displayed messages, a
two-character unsent draft, and a stopped execution. Send was disabled because
the composer treated `stopped` as a permanently failed state. The draft was
left untouched.

The User requested faster cached Project/Conversation discovery and working
continuation. Saved removal preferences already live in the local authority;
they must also filter cached rows before display. The cache is restricted to
the currently verified account and backend, stores catalog metadata rather than
conversation bodies, and refreshes in the background. Desktop uses the existing
encrypted device store because its gateway port changes after restarting;
browser Studio uses local storage. A lightweight Personal scope request avoids
waiting for the full Home activity snapshot before restoring the catalog.
Catalog cursor pages reuse bounded scan snapshots instead of rescanning disk.

Continuation reuses the existing prompt route with an explicit
`resumeFromStopped: true` admission flag. Only a clean stopped execution with
its original provider binding can resume. Generation, provider session,
execution identity and history remain unchanged. Failed, fenced, unresolved
and missing-history executions remain blocked. The flag is persisted with the
device's send identity for safe retry and is excluded from Agent context.

Focused gateway scope/refresh tests passed 2/2, including an account change and
authorization failure. Device draft/send recovery tests passed 14/14. Catalog
scan cache regressions passed 26/26 and the real metadata fixture still contains
132 Conversations in one Project without duplicate IDs. Final integrated build
and native continuation/cache checks are pending at this entry.

The same stopped-chat continuation is enabled in hosted Studio, using its
existing prompt client and device recovery store. Hosted client checks passed
34/34. Backend repository checks passed 22/22, API route checks 67/67 and worker
service checks 81/81; their typechecks and builds passed. The initial stopped
admission needed no migration. Explicit archived-thread continuation subsequently
added migration 0072 for a command-level permission flag, separate from prompts
and Agent context. The complete gateway suite passed 20/20.

The packaged Desktop restored the encrypted catalog (50 entries, 16 registered
Projects and 22 saved removals) after verifying the account. An isolated native
window displayed cached Project rows while fresh Home, Project and catalog
responses were held; the background requests remained bounded. The existing
two-character draft also restored exactly after the restart. No removal
preferences or user files were changed.

A live continuation request for How Rain Forms was accepted on the original
execution and generation, but the runtime failed before any new message
appeared in its stored history. Koed retained the nine original messages and marked the outcome
uncertain. The provider-resume investigation remains open; this entry does not
claim a successful end-to-end continuation. The verification used a separate
explicit QA prompt and never sent the user's saved draft.

A read-only Codex app-server probe reported JSON-RPC `-32600`: the persisted
original thread was archived. This establishes its provider state, but does
not establish the cause of the failing managed command. The active transcript
path is absent because the thread is archived; its full provider history is
available through read-only `thread/read` and matches the binding. The correction is
restricted to explicit continuation of that same thread; background startup
recovery must not unarchive it or create a replacement thread.

The User also reported that the model/reasoning popup would not dismiss. The
shared composer now closes it after selection and on pointer input outside the
actual menu, including a click or touch on the draft inside the composer.
Escape and the trigger toggle remain available. The interaction and existing
client-selection tests passed 7/7; targeted ESLint and the Studio production
build passed. Native verification passed: the menu opens, closes on a draft
click/touch and closes with Escape, while the current 50-character draft is
unchanged.

Two earlier failed sends were repaired only after fresh complete provider
history proved their exact client message IDs were absent, all stored turns
were terminal, and identity, binding, version and lease checks passed under
locks. The commands were marked as proved undispatched; execution history and
generation were preserved. A subsequent QA send still became indeterminate
without adding history. Investigation remains open; no successful continuation
is claimed yet. The current package also restored the encrypted catalog and
the exact 50-character draft after its local gateway port changed.

The diagnostic package identified the live cause on command fc449b2d: reopening
the same provider thread succeeded, then transcript reconciliation failed with
`transcript_prefix_mutated`, before a provider turn started. The worker had
marked dispatch too early, causing a preflight failure to become indeterminate.
A narrow reconciliation and dispatch-boundary correction is in progress.

### Approved rewritten-transcript recovery

The existing source-successor route preserves the parent's byte/line frontier.
It cannot register a rewritten provider file whose offsets changed. Do not
skip prefix verification, rewind existing cursors, edit immutable segments,
or replay the whole rewritten file without stable identity proof.

Proposed extension: an explicit, owner-authorized continuation may close the
original source generation and register a successor at a newly verified file
frontier, preserving its closure hash, journal, captured memories, execution
and provider thread. Before registering, verify the same bound thread, full
terminal provider history, all original canonical message identities/content,
absence of the new prompt, no unsettled turn or lease, and an unchanged local
file digest/frontier. Start collecting future messages from that frontier;
never replay the rewritten prefix. Fail closed if any history or identity
proof is missing. Background recovery cannot initiate this operation.

The User approved this new API/storage contract on 2026-10-04 after the
integration workflow's backend-contract discussion. The active explicit
continuation may hold its own dispatch lease; no prior unresolved turn or
command may be skipped. The actual dispatch-boundary fix
is complete separately: preflight errors no longer count as dispatched turns.
MCP checks passed 43/44 (one existing skipped), worker checks 81/81, and both
packages' typechecks/builds passed. Native continuation remains unverified.

### Verified rebase implementation checks

The approved extension is implemented as an authenticated rebase-successor
operation, with durable proof metadata in migration 0073. The authority
validates the explicit prompt, owner/origin/runner/lease, generation/thread
binding and canonical message multiset. It seals the parent and rebinds the
execution/runtime source generation atomically. The original journal and
consumer cursors remain intact. The child keeps the stable source fingerprint;
the accepted file-prefix digest is separate durable proof metadata, returned
through the existing generation lookup. The worker checks that prefix on every
explicit preflight, including after restart and before any child segment exists.

Provider full-history reads matched all five original user messages by client
ID and text digest, and all four assistant messages by turn ID and text digest.
The parent's canonical cursor already equals its provider cursor, so no old
journal backlog is stranded. Provider status and local-file bytes are runner
attestations; the authority independently checks canonical messages and the
current command's authorization.

Deferred sessions cannot dispatch or ordinarily reconcile until verification
completes. Failed proof closes and discards the session without ingesting the
unverified prefix. Independent review found and corrected both close-path
reconciliation guards and found no remaining concrete blocker in the final
recheck. A separate root review corrected source fingerprint preservation.

Focused MCP checks: 44 passed, 1 skipped. Worker service checks: 429 passed,
3 skipped. DB rebase/journal checks: 2 passed; API schema/route identity checks:
20 passed. DB/MCP/worker/API builds and relevant typechecks passed. A broader
MCP invocation accidentally ran the package suite and failed a curated-memory
fake-Claude executable expectation in this local installation; no full-suite
green claim is made. Native package signature verification passed.

The diagnostic QA command fc449 was repaired only after a fresh proof showed
its exact client message absent from complete terminal provider history under
the original identity/version guards. Final native testing is currently waiting
for macOS Keychain approval for the updated package; no end-to-end pass is
claimed yet. The current 50-character draft's exact hash was unchanged before
restart.

### Pre-push checks (2026-10-04)

Targeted formatting of all changed source, test, documentation and migration
snapshot files passed after formatting-only corrections. Diff whitespace
validation passed. The default installed ESLint 10.4.0 crashed while loading
`react/display-name` (`contextOrFilename.getFilename is not a function`).
Running the same touched-file set with installed ESLint 9.39.5 completed,
but reported 262 errors, including Node/browser global configuration, test
Promise handling, unused variables and typed-rule errors. These were not
classified as a verified baseline; no lint-green claim is made. Existing
focused build/test results above remain the verification evidence.

The User requested pushing all pending changes with these limitations
recorded. Final native continuation verification remains pending.
