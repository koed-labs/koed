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

## Findings before cut-over

The parity review identified two production behavior gaps that the earlier
component proofs did not cover:

1. **S02.1: Conversation-origin work without a ticket.** A keyless Work Item
   can represent this work and already has a brief and live log. The current
   row omits its origin/activity description, the brief renders an opaque
   `originRef`, and the source-Conversation link is absent. The close control
   exists, as it does in v50; its return-to-chat behavior still needs the journey
   assertion. The approved origin-linked journey needs a trusted producer and
   executable proof. A brief for an unrelated runtime without a Work Item is
   not an additional requirement.
2. **S15.1 / S15.3: named Team navigation.** The sidebar has Just me and Shared
   groups. Named Teams and their Projects are available through management
   controls, but the approved named Team sidebar group and fold are missing.
   Add the named group using authoritative Team and Project links. Keep the
   small owner-managed Team used by a separately shared Project under Shared.

The inventories also retain unproved compound journeys, including text-driven
actions, the exact Native merge flow, full invitation acceptance and ordinary
agent-turn prompt isolation. These are coverage gaps until an executable check
or a missing production capability establishes otherwise. Do not infer that an
AI Client command is absent merely because its literal text does not appear in
the renderer.

The approved Team-thread deferrals remain deferred: Agent mentions/replies,
decisions or contradictions saved from Team messages, and Team documents
automatically becoming Project Sources. No acceptance assertion was removed or
relaxed during this review. Current assertion results belong to the generated
parity record, not to a manual checklist in this document.
