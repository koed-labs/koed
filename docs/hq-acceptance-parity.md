# HQ acceptance parity

HQ-901 is a release gate. A successful component harness does not establish
parity with every approved user journey. HQ-902 must wait until all approved
assertions have executable green evidence and the remaining product gaps close.

The assertion contract contains 89 identities: simulated IPC assertions,
unit and real-API assertions, Team repository assertions, and the 14 two-user
steps. These identities preserve the approved acceptance map. The historical
prototype is a visual and behavior reference; the final product decisions take
precedence over its obsolete sharing, merging and Team-thread behavior.

## Owning proofs

- `apps/desktop/scripts/hq-acceptance-contract.mjs` lists the approved identities.
- `validate-hq901-early-proofs.mjs` and `validate-hq901-late-proofs.mjs` map
  Desktop clauses to executable validators and their exact result records.
- `scripts/hq-acceptance-owned-suites.mjs` maps the other assertions to exact
  test files and unique test titles, or to the real two-user assertion records.
- `scripts/hq-acceptance-parity.mjs` executes the owning harnesses and produces
  an assertion-level parity record. Unproved clauses remain explicit failures.
- [The action catalogue review](hq-ui-action-parity.md) records the historical
  controls and their current owners, overrides and unresolved coverage.

Run the parity command after building the workspace. Use disposable PostgreSQL
17 databases with pgvector and a role that can create the isolated child
databases. Configure `KOED_HQ713_TEST_DATABASE_URL` and each owning suite's test
database variable to those disposable databases. Never use production data.

```sh
pnpm build
pnpm test:hq-parity --output=<ignored-evidence-directory>
```

The command runs the owning unit/repository suites, the new-HQ Electron browser
chain and the real Team/two-Personal-backend contract with its Native companion.
It never launches the legacy browser validators. Existing checks remain
required; this command does not replace formatting, lint, typechecking,
migration or packaging checks. The generated output must be inside the
checkout's ignored temporary directory.

The result records commands, exit codes, timings, the starting Git head and a
digest of all tracked and new source files. A source change during the run
invalidates the result. A local integration report may bind that same digest
to the final commit after checking that its source bytes are identical.
Skipped cases, duplicate test titles, unrelated passing tests, stale Native
reports and simulated results cannot supply real-backend proof. A successful
adjacent test never closes a clause listed as unproved.

## Journey boundaries

Conversation-origin Work Items derive their source Session from the exact
claimed human action. The row and brief show the readable origin and current
work; the origin link opens that Conversation without borrowing the Work
Item's separate execution identity.

Named Team groups use immutable Team creation origin and authoritative backend,
Workspace and Project links. Separately shared Projects remain under Shared;
renaming a Team never changes this placement. See
[Team sidebar origin](team-sidebar-origin.md).

The invitation journey also verifies a visible welcome in the recipient's
private HQ. Its simulated AI Client reply is backed by a production route test
that queues the welcome through the private catch-up path with no Team message
text in its prompt. The invitation card alone does not establish that welcome.

The Electron chain runs the full simulated journeys, including three document
creation entry points, typed actions, Native merge review in Full access,
invitation acceptance, private citations and deletion/Undo. Each run creates
fresh isolated profiles. Its aggregate fails if any of the 49 simulated
assertions has a missing, stale or partial proof. This aggregate establishes
simulated IPC coverage only; the release gate also requires all real/unit
prerequisites.

Simulated AI Client replies and provider outcomes remain explicit fixtures.
Separate production tests cover catch-up input filtering, normal capture of an
agent's closing reply, durable citations, document idempotence, and the Native
single-use merge journal. Koed does not synthesize a closing reply in a backend
service. The managed prompt spy observes the actual provider input with a
present Team-message sentinel; it does not infer isolation from an empty store.

The real three-server lifecycle test coordinates an in-flight publication with
Project deletion, checks an independent grant continues advancing, and checks
revocation, suppression and expiry. Parent lifecycle transactions lock their
complete affected grant set in ID order before acquiring policy freeze locks.
This preserves the same ordering as publication across multi-member deletion
and Team leave.

The approved Team-thread deferrals remain deferred: Agent mentions/replies,
decisions or contradictions saved from Team messages, and Team documents
automatically becoming Project Sources. No acceptance assertion was removed or
relaxed during this review. Current assertion results belong to the generated
parity record, not to a manual checklist in this document.
