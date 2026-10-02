# Studio Pull Request review

This implements the combined scope of frontend Tickets 16–18. The existing Studio prototype defines the layout. Orys is a code reference.

## Workflow

1. Open **Settings → Plugins → GitHub** and explicitly select an installed GitHub CLI account, or sign in in the browser. Credentials remain on the selected computer.
2. Open **Pull Requests**. The default inbox combines PRs you authored and PRs requesting your review. Use the tabs or repository selector to narrow the list.
3. Open a PR and choose your Agent, execution computer, model, permissions and optional Project. Start a review. Studio creates a private managed chat and an ordinary Agent Job.
4. The Agent inspects an isolated checkout at the displayed base and head revisions. Review mode is read-only. Enable fixes explicitly before allowing edits.
5. Review and edit the draft, choose Comment, Approve or Request changes, and select valid changed-line comments. Preview the frozen content and confirm publication. To revise a preview, choose **Edit draft**, save the changes and generate a new preview; the old confirmation cannot authorize the new revision.
6. For fixes, inspect the exact proposed diff and branch, then confirm a normal push. Studio does not automatically post, push, or merge.
7. If commits change, the earlier review remains available but is outdated. **Review latest changes** requires an explicit request. Uncommitted edits must be resolved before changing the checkout.
8. Pending work on an offline computer may be cancelled before the computer claims it. An uncertain publication or push must be checked by reading the remote outcome; it must never be blindly replayed.

Team Project review Jobs follow the existing Public Square visibility rules. Personal Jobs appear in Home and Agents activity. The full Agent conversation remains private. Multiple Agents have separate Jobs, chats and drafts.

## Acceptance checks

Use a disposable repository and PR for publication and push checks. Inspect and approve the exact outgoing content before any real GitHub write. Do not run write checks against unrelated user repositories.

- Select an account explicitly. Confirm no account is adopted silently, secrets never appear in renderer responses, and disconnect invalidates old queued operations.
- Confirm authored/review-requested inbox filtering, repository selection, PR code, checks and existing reviews.
- Start an Agent review. Confirm the checkout matches both displayed revisions, Project files remain untouched, and the Job appears in the correct Personal or Team activity surface.
- Reload the app and open the same PR/Agent. Confirm private chat and draft persist. A second Agent must get separate history.
- Confirm review-only execution cannot edit files. Enable fixes explicitly and confirm execution permissions still apply.
- Edit a draft and preview it. Confirm the posted body, action and inline comments match the frozen preview, including the stable reconciliation marker.
- Add a commit externally. Confirm stale drafts cannot be posted, no automatic Agent review starts, and an explicit latest review updates the inspected revision.
- Inspect a fix proposal; change its local files, remote head, account or connection generation. Confirm the old proposal is rejected. Confirm non-fast-forward pushes and merge are unavailable.
- Disconnect the runner, enqueue work from web Studio, and cancel before claim. Reconnect and confirm cancelled work does not run.
- Simulate loss of the response after publication/push. Confirm the operation stays uncertain and an outcome check performs only reads. Confirm duplicate writes cannot occur.
- Confirm another account/device cannot read history, claim work or substitute its own execution, repository, freeze or push proposal.

Automated fixture results and any remaining live-environment limitations are recorded in the ticket review notes. Passing fixture checks does not imply a real GitHub review was posted or a branch was pushed.

## Runtime boundaries

GitHub credentials stay with the selected computer's GitHub CLI. PR review processes receive an environment without GitHub tokens or the user's Git credential configuration. Claude and Pi review file tools check canonical paths against the isolated PR checkout, including symlink targets. Codex uses its existing read-only execution policy. These controls are not a claim that every provider supplies an operating-system sandbox; explicitly enabled fixes continue to use the selected provider's normal execution permissions.

Publication and push confirm the exact account ID/login and connection generation immediately before dispatch. Connection changes and writes are serialized within a runner process; this is not a cross-process lock on external GitHub CLI sessions. GitHub's remote revision checks and the push's exact-head lease provide the remote fence. Uncertain writes remain uncertain until a read-only outcome check confirms them.

The Git push driver uses an explicit expected-head lease as a compare-and-set guard, after proving the proposed commit descends from that head. This prevents a concurrent branch change from bypassing the exact confirmation. The driver rejects non-fast-forward history; the lease is not permission to rewrite history.

## Validation record — 2026-10-02

The maintained Studio browser regression suite passed all 17 tests, including the two PR workflows and existing Agent, Team, Settings and responsive views. PR browser checks exercise managed chat recovery, exact frozen review confirmation, fix permissions, proposed push diffs, Pending cancellation and read-only uncertain-outcome reconciliation. External GitHub writes in these checks are synthetic fixtures. The final focused PR browser run also passed both tests after adding edit/save/refreeze recovery and scoped history hydration.

The full Studio test command passed 33 Agent tests and 320 Node tests. The worker suite passed 409 tests with three existing skips. Focused provider tests passed 48 Claude/Pi checks; native/upstream routing, checkout isolation, publication, push, output reconciliation and source-control authority tests also passed. PostgreSQL 17 integration checks covered the new encrypted PR authority and existing Public Square Job publication, using disposable databases.

Final shared, DB, MCP, worker, API and hosted/native Studio production builds passed. The final native export is left in place. Changed frontend lint has zero errors or warnings, and all changed source/doc formatting checks pass. Final authority checks passed 72 API/routing tests and 30 focused runner tests; these overlap the broader suites and are not additive. PostgreSQL tests also proved microsecond pagination, scoped older-review recovery and rejection of stale execution generations.

The installed GitHub CLI was checked through account discovery only. No account was selected or signed in, no real GitHub review was posted and no remote branch was pushed. Live writes still require the User to select an account and approve exact outgoing content in a disposable PR. The migration has been tested in disposable PostgreSQL, not applied to a deployed backend. This change does not claim a live multi-computer/provider matrix was repeated.

The combined minor release entry is deferred to the epic review, as agreed. Changes remain on `epic/ui-revamp` without a GitHub push until the User confirms.
