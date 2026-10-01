# Studio integration handover

## Delivery boundary

The current integration is on `epic/ui-revamp` in `koed-labs/koed`. This orchestrated delivery ends at Ticket15. Tickets16–23 remain for the User and colleagues. Their discussion and implementation have not been authorized here.

The editable planning ledger lives in the prototype checkout at `.scratch/koed-frontend-integration/`: `status.md`, `decisions.md`, `review-notes.md`, `product-documentation-notes.md`, `ticket-index.md`, individual `issues/`, and per-ticket review scripts. These local planning files and private review artifacts are intentionally outside the GitHub commits. Preserve them when transferring the project.

## Integration rules to preserve

- The prototype defines the presentation and user-facing flows. Reuse Koed's existing backend, native folder picker, execution, encryption and delivery infrastructure.
- Personal conversations and Memory stay private unless an explicit authorized sharing or publication workflow applies. A Team Project does not publish a private Agent conversation.
- Agent profiles belong to the account; Job history survives profile rename and retirement. Model/effort are execution choices, separate from the Job goal.
- Team channels and reviewed Agent publications are distinct from private human–Agent conversations. Team Project channels do not share messages across Teams.
- Pending starts/moves and receipt-backed message delivery keep stable identities. Never resend an accepted Agent prompt to repair a test script.
- Memory corrections require separate product agreement. Recall feedback is quality-assurance data and must not modify Memory or retrieval behavior.

## Remaining work

| Area                      | Next work                                                                                                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub                    | Ticket16: first GitHub plugin and account connection.                                                                                                                         |
| Pull Requests             | Tickets17–18: trace and port the existing Rust product behavior from `koed-labs/orys`, preserving the approved reference workflow rather than copying the old Koed review UI. |
| Home / For you            | Tickets19–20: connect attention summaries and actions to the new authority; preserve recorded Agent proposal, question and notification follow-ups.                           |
| Work progress             | Ticket21: Story and Advanced views.                                                                                                                                           |
| Additional plugins/skills | Ticket22: separately approved integrations. Plugins remain under Settings.                                                                                                    |
| Packaging/release         | Ticket23: installation and launch paths, final release-selected acceptance, and the combined epic changeset.                                                                  |

Earlier explicitly deferred checks remain deferred; a later ticket passing does not silently complete them. Consult the current ledger and each review script for physical-device, provider, offline-restart and structured-question follow-ups. Memory Inbox remains disabled. Browser native-folder registration and collaborative project-creation follow-ups remain recorded in the planning notes. Popup/system notifications are later work.

## Validation workflow

Use `validation-workflow.md` from the planning folder. Assign bounded modules to GPT-6 Luna High workers with `fork_turns: "none"`, preserve other contributors' changes, and avoid recursive delegation. Trace existing wiring before implementation. Resolve new product decisions before adding a dependent contract.

Test changed authority and persistence boundaries with scoped checks. Reuse unchanged provider/device evidence. Use the Studio review-only Desktop entrypoint for native acceptance; do not launch the old toolbar as the new Studio. Build the relevant dependency closure in an isolated review checkout. Include Desktop `build:preload` after Electron TypeScript compilation. Make sure that `window.koedStudioChatRecovery` exists before native draft tests. Record the source revision and run the final flow after workers freeze their files. Private credentials and fixtures must not enter commits.

## Ticket15 verification and open decision

Personal recall feedback is implemented and verified on `epic/ui-revamp`, based on `6838a10e`. The User authorized publication on October 1, 2026. Implementation commit: `5a7526a2`.

Scoped checks passed:

- Shared contract: 3 tests, including the Unicode limit.
- API feedback and proxy: 47 tests. Existing history: 67 tests, including revoked-source labels and recall without displayed citations.
- DB repository: 12 tests. Isolated PostgreSQL: 1 integration case, including populated upgrade through migration0063 and encrypted comment/source storage.
- Studio configured suite: 297 tests. Native chat transport: 10 tests. Attribution: 4 tests. Studio proxy: 19 tests.
- Desktop manager: 92 tests. Shared, DB, API and Studio typechecks passed.
- Native and hosted review builds, migration metadata, formatting and Git diff checks passed. Test groups overlap and must not be summed.

Live Desktop and web checks passed for rating submission, change, withdrawal, comment reload, failed saves, later edits during a save, and offline draft recovery. Browser checks confirmed ciphertext storage and account isolation. Native checks confirmed the recovery bridge and draft restoration after a full Desktop restart. Feedback created no execution commands and left the original recalled answer unchanged.

The UI review source digest was `b6ece607632309de723e0f9dfc819f21844cf9faa1a3c8268bc5e4b7a7a2f5b9`. The final shared change aligned the Unicode limit with Studio. Its focused tests and final hosted API rejection check passed. Private review artifacts remain outside Git.

One product decision remains open: implement Personal feedback and defer Team-visible recalled-answer integration, or add a Team answer publication flow now. Team channels currently have no verified recalled-answer association. Private answers that use Team evidence remain private. Do not infer public provenance from a shared Project or a channel summary.

Ticket15 remains open for that decision. Tickets16–23 remain outside this delivery. Memory correction, a QA dashboard, notifications and the combined epic changeset remain deferred.
