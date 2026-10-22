// HQ-901 approved non-simulated acceptance claims. This is a traceability
// registry, not evidence that a test ran: the coordinator must match exact
// Vitest titles, reject skipped/pending cases, and require HQ-713 record IDs.
// An empty `proof` or nonempty `unresolvedClauses` is an explicit gap and must
// fail the acceptance gate even when every listed adjacent test passes.
const real = "apps/api/tests/hq-integration/hq713-two-user.integration.ts";
const main =
  "shares, recalls, revokes, and restores through listening production APIs";
const curated =
  "requires separate consent for exact-Session Curated sharing and scope withdrawal";
const leave = "keeps Team leave and frozen grants isolated from prior deletion";
const ownedLeave = "copies a last owner's Team Project back exactly once";
// `title` is the exact leaf title. Match it uniquely within `file` in the
// Vitest JSON result; a duplicate title must fail rather than select a pass.
const unit = (file, title) => ({
  kind: "vitest",
  file,
  title,
  titleMatch: "exact-leaf-unique-in-file"
});
const integration = (title, record) => ({
  kind: "hq713-record",
  file: real,
  title,
  record
});

export const ownedAcceptanceSuites = [
  {
    id: "U21.1",
    clause:
      "The same due_on is relative to each viewer's time zone without moving its stored calendar date.",
    proof: [
      unit(
        "apps/desktop/src/renderer/hq/due/hq-due-model.test.ts",
        "reads one calendar date in each viewer's time zone without moving its stored date"
      )
    ]
  },
  {
    id: "I03.1",
    clause:
      "Colleague work reveals a privacy note, safe status and step, with no private chat link or content.",
    proof: [
      unit(
        "apps/desktop/src/renderer/hq/shared-project/SharedProjectPanel.test.tsx",
        "shows safe colleague progress with a privacy note and no private chat link"
      ),
      integration(main, "HQ713-step5-private-agent-boundary")
    ]
  },
  {
    id: "I13.1",
    clause: "Share and join disclose summaries and yield Bob's own private HQ.",
    proof: [
      integration(main, "I13-I14-step1-step2-share-join"),
      integration(main, "HQ713-step2-private-project-HQ"),
      integration(main, "I713.Native")
    ]
  },
  {
    id: "I14.1",
    clause:
      "Real invitation and share effects: reviewed scope, accepted link, shared work and retained owner boundaries.",
    proof: [
      integration(main, "I13-I14-step1-step2-share-join"),
      integration(main, "HQ713-step4-work-item-CAS"),
      integration(main, "I713.Native")
    ]
  },
  {
    id: "I20.3",
    clause:
      "Team leave copies owned Project work back without removing retained shared evidence.",
    proof: [integration(leave, "I713.11"), integration(ownedLeave, "I713.14")]
  },
  {
    id: "I24.1",
    clause:
      "Deleted/left source grants pin the last authorized publication and do not resume on restore.",
    proof: [
      integration(main, "I24"),
      integration(main, "I713.8"),
      integration(main, "I713.9"),
      integration(leave, "I713.11")
    ]
  },
  {
    id: "I25.1",
    clause:
      "Owned leave copy-back resumes once; last-owner preflight blocks mutation until ownership transfer.",
    proof: [integration(ownedLeave, "I25"), integration(ownedLeave, "I713.14")]
  },
  {
    id: "I26.1",
    clause:
      "Shared deck/cards coexist with separate per-member progress and private Again learning.",
    proof: [
      integration(main, "I26"),
      integration(main, "I713.13"),
      integration(main, "I713.13.learning.alice"),
      integration(main, "I713.13.learning.bob")
    ]
  },
  {
    id: "I27.1",
    clause:
      "Explicit Curated consent admits only exact-session Project evidence and invalidates prior Team material on scope change.",
    proof: [
      integration(curated, "I27"),
      integration(curated, "I27.scope-change")
    ]
  },
  {
    id: "I28.1",
    clause:
      "Multiple persisted citations reload and reauthorize after Team revocation.",
    proof: [
      integration(main, "I28.question-history"),
      integration(main, "I28.question-history-revoked"),
      integration(main, "I28.managed-turn"),
      integration(main, "I28.managed-turn-revoked")
    ]
  },
  {
    id: "U29.1",
    clause:
      "Merge readiness drift conflicts; uncertain dispatch reconciles without another mutation.",
    proof: [
      unit(
        "apps/api/src/source-control/runtime.test.ts",
        "requires fresh review when checks change on the same head"
      ),
      unit(
        "apps/desktop/src/koed-server/source-control-merge-native-client.test.ts",
        "returns only the journal identity after an uncertain dispatch and never retries"
      ),
      unit(
        "apps/api/src/source-control/merge-provider-driver.test.ts",
        "does not credit another actor's merge after a dispatch timeout"
      )
    ]
  },
  {
    id: "I30.1",
    clause:
      "Trusted Personal selector includes linked Project plus Me; Team selector uses trusted global Workspace/backend fields and no personal project_id.",
    proof: [
      integration(main, "I30"),
      integration(main, "I30.runtime-selectors"),
      integration(main, "I30.runtime-Team-unavailable")
    ]
  },
  {
    id: "N1.U",
    clause:
      "With Team messages present, catch-up, memory proposal and agent-turn prompt spies see no Team message text.",
    proof: [
      unit(
        "apps/api/src/projects/project-catch-up.test.ts",
        "keeps finished Work Items and merged PRs out of Team catch-up prose"
      ),
      unit(
        "packages/mcp-server/tests/curated-memory-review-worker.test.ts",
        "excludes a Team message field from the actual Curated review agent prompt"
      ),
      unit(
        "apps/worker/src/memory-action-observer.test.ts",
        "creates a reviewed correction only from the exact captured User item"
      )
    ],
    unresolvedClauses: [
      "Catch-up, Curated review and managed correction proposal boundaries exclude extra Team-message fields. The full claim still needs an ordinary managed agent-turn prompt spy with Team messages present. That requires an injectable provider session at the command-to-runTurn boundary; current narrow unit fixtures do not expose it."
    ]
  },
  {
    id: "N2.I",
    clause: "Project Share Policy creates no Conversation Source Access.",
    proof: [integration(main, "N2")]
  },
  {
    id: "N3.U",
    clause:
      "Every merge needs fresh Native review even in Full access; drift, method policy, duplicate dispatch and uncertainty fail closed.",
    proof: [
      unit(
        "apps/desktop/src/koed-server/source-control-merge-native-client.test.ts",
        "never dispatches a merge when Native review is declined regardless of permission mode"
      ),
      unit(
        "apps/api/src/source-control/runtime.test.ts",
        "requires fresh review when checks change on the same head"
      ),
      unit(
        "apps/api/src/source-control/merge-provider-driver.test.ts",
        "uses the exact protected head, allowed method, complete readiness and no bypass"
      ),
      unit(
        "packages/db/src/source-control-merge-repository.test.ts",
        "claims one approval once and fences another approval for the same PR across processes"
      ),
      unit(
        "apps/desktop/src/koed-server/source-control-merge-native-client.test.ts",
        "returns only the journal identity after an uncertain dispatch and never retries"
      )
    ]
  },
  {
    id: "N4.U",
    clause:
      "Launched AI Client process receives no source-control credential in env or arguments.",
    proof: [
      unit(
        "packages/mcp-server/tests/ai-client-runner.test.ts",
        "passes only the bounded environment and removes provider credentials"
      ),
      unit(
        "packages/mcp-server/tests/ai-client-runner.test.ts",
        "spawns JavaScript Claude SDK entries through the trusted runtime"
      ),
      unit(
        "packages/mcp-server/tests/ai-client-runner.test.ts",
        "keeps source-control credentials out of the launched AI Client environment and arguments"
      ),
      unit(
        "packages/mcp-server/tests/pi-rpc-runner.test.ts",
        "uses minimal environment without Koed or provider credentials"
      )
    ]
  },
  {
    id: "N5.I",
    clause: "Owner Desktop cannot grant another member's Conversation.",
    proof: [integration(main, "N5")]
  },
  {
    id: "N6.I",
    clause: "Leave has no Undo; restore never revives frozen/revoked access.",
    proof: [
      unit(
        "apps/desktop/src/renderer/hq/HqTeamGroups.test.tsx",
        "shows the exact owned Project effect before the real leave action and offers no Undo"
      ),
      integration(main, "N6")
    ]
  },
  {
    id: "N7.U",
    clause:
      "Deleting a chat retains its Personal recall; Forget this chat removes it.",
    proof: [
      unit(
        "packages/db/src/chat-lifecycle.test.ts",
        "keeps owned recall after trash, excludes navigation, and restores within 30 days"
      ),
      unit(
        "packages/db/src/chat-lifecycle.test.ts",
        "forgets only Personal evidence and restores exact evidence on Undo"
      )
    ]
  },
  {
    id: "N8.I",
    clause:
      "Curated positive exact granted Conversation control passes; Me, unscoped, mixed-session and non-Conversation controls remain Personal.",
    proof: [integration(curated, "N8")]
  },
  {
    id: "N9.U",
    clause:
      "An open or closed-unmerged PR never marks Work Item Done; merged provider evidence is required.",
    proof: [
      unit(
        "apps/api/src/work-items/pr-reconciliation.pg.test.ts",
        "leaves an open PR In review and marks closed-unmerged Blocked"
      ),
      unit(
        "apps/api/src/work-items/pr-reconciliation.pg.test.ts",
        "moves a quiesced execution's item to Done only after provider merged reads, once"
      )
    ]
  },
  {
    id: "N10.U",
    clause:
      "Two online devices cannot materialize or start the same scheduled run.",
    proof: [
      unit(
        "apps/api/src/scheduled-jobs/runtime-tick.test.ts",
        "only the assigned device materializes and an overlapping occurrence is skipped"
      ),
      unit(
        "apps/api/src/scheduled-jobs/runtime-tick.test.ts",
        "allows only one of two online devices to claim the same scheduled run"
      )
    ]
  },
  {
    id: "N11.T",
    clause:
      "Freeze linearizes with an in-flight publication, pins a closed frontier, leaves a second grant advancing, and denies revoked/suppressed/expired access.",
    proof: [
      unit(
        "packages/db/tests/shared-memory-repository.test.ts",
        "linearizes an in-flight legacy row writer with a whole-transaction freeze retry"
      ),
      unit(
        "packages/db/tests/shared-memory-repository.test.ts",
        "rejects legacy READ COMMITTED and stale repeatable-read publication after freeze"
      ),
      unit(
        "packages/db/src/workspace-project-grant-lifecycle.test.ts",
        "atomically freezes all bound grants on owner delete and leaves independent grants active"
      ),
      unit(
        "packages/db/tests/shared-memory-repository.test.ts",
        "invalidates the frozen copy when its exact sanitized preview is privacy-invalidated"
      ),
      unit(
        "packages/db/tests/shared-memory-repository.test.ts",
        "keeps current consent expiry authoritative for a frozen representation"
      ),
      unit(
        "packages/db/tests/shared-memory-repository.test.ts",
        "freezes a Memory Answer grant set while revocation and regrant fail closed"
      )
    ]
  },
  {
    id: "N11.I",
    clause:
      "Real-backend freeze pins published material and leaves independent grant publication valid while denial states stay enforced.",
    proof: [integration(main, "N11.post-freeze"), integration(main, "I24")],
    unresolvedClauses: [
      "The HQ-713 record names do not expose all suppression/expiry and second-grant advancement facets; inspect current execution evidence before claiming full N11.I."
    ]
  },
  {
    id: "N12.U",
    clause:
      "memory_forget ownership check never falls back from cited/latest teammate item to older owned item; ambiguity asks.",
    proof: [
      unit(
        "apps/worker/src/memory-action-observer.test.ts",
        "keeps latest cited teammate ownership and never mutates the older owned source"
      ),
      unit(
        "apps/worker/src/memory-action-observer.test.ts",
        "rejects a model-selected older alias against an unqualified User prompt"
      ),
      unit(
        "apps/worker/src/memory-action-selection.test.ts",
        "rejects unrendered and multiple explicit references"
      ),
      unit(
        "apps/worker/src/memory-action-selection.test.ts",
        "asks when the same displayed citation number occurs in multiple answers"
      )
    ]
  },
  {
    id: "N13.U",
    clause:
      "Source trash and Note revision Forget are independent; Source never marks Session personal_deleted_at; retry creates no duplicate Note revision or Memory Event.",
    proof: [
      unit(
        "apps/api/src/projects/source-ingestion.integration.test.ts",
        "ingests real PDF/DOCX and >32 KiB text into one event per actual Note revision"
      ),
      unit(
        "packages/db/src/project-source-repository.test.ts",
        "deletes only active references in its exact batch and Undo preserves prior trash"
      )
    ]
  },
  {
    id: "I713.01",
    clause:
      "Alice shares landing; share review lists docs, to-dos and summaries.",
    proof: [
      integration(main, "I13-I14-step1-step2-share-join"),
      integration(main, "I713.Native")
    ]
  },
  {
    id: "I713.02",
    clause:
      "Bob accepts summary-sharing disclosure, sees Shared landing and private HQ.",
    proof: [
      integration(main, "I13-I14-step1-step2-share-join"),
      integration(main, "HQ713-step2-private-project-HQ"),
      integration(main, "I713.Native")
    ]
  },
  {
    id: "I713.03",
    clause:
      "Alice chat summary recalls with Team citation but no reachable transcript.",
    proof: [integration(main, "I713.3"), integration(main, "N2")]
  },
  {
    id: "I713.04",
    clause:
      "Both users see work-item updates; concurrent title edits conflict without loss.",
    proof: [integration(main, "HQ713-step4-work-item-CAS")]
  },
  {
    id: "I713.05",
    clause: "Alice sees Bob's agent work status/step only.",
    proof: [integration(main, "HQ713-step5-private-agent-boundary")]
  },
  {
    id: "I713.06",
    clause: "Making Alice chat private removes its summary from Bob's recall.",
    proof: [integration(main, "I713.6")]
  },
  {
    id: "I713.07",
    clause: "Offline Team backend makes Project read-only with notice.",
    proof: [integration(main, "HQ713-step7-Team-offline")]
  },
  {
    id: "I713.08",
    clause:
      "Delete removes Project from Bob, retains published recall and freezes Bob grants before later source.",
    proof: [integration(main, "I713.8"), integration(main, "N11.post-freeze")]
  },
  {
    id: "I713.09",
    clause:
      "Restore returns records and thread while Bob's moved chats/frozen grants stay detached.",
    proof: [integration(main, "I713.9"), integration(main, "N6")]
  },
  {
    id: "I713.10",
    clause: "Interrupted second share resumes without duplicates.",
    proof: [integration(main, "HQ713-step10-interrupted-first-share")]
  },
  {
    id: "I713.11",
    clause:
      "Team leave freezes Bob publication for Alice, denies Bob Alice recall; Project leave preserves membership.",
    proof: [
      integration(leave, "I713.11"),
      integration(leave, "I713.11.project-leave")
    ]
  },
  {
    id: "I713.12",
    clause:
      "Curated positive/negative eligibility, scope invalidation and trusted Personal/Team selectors.",
    proof: [
      integration(curated, "I713.12"),
      integration(curated, "I27.scope-change"),
      integration(main, "I30"),
      integration(main, "I30.runtime-selectors")
    ]
  },
  {
    id: "I713.13",
    clause: "Shared cards with member-private progress and Again learning.",
    proof: [
      integration(main, "I713.13"),
      integration(main, "I713.13.learning.alice"),
      integration(main, "I713.13.learning.bob")
    ]
  },
  {
    id: "I713.14",
    clause:
      "Owned leave resumes exact copy once and blocks last-owner until transfer and revalidation.",
    proof: [integration(ownedLeave, "I713.14"), integration(ownedLeave, "I25")]
  }
];
