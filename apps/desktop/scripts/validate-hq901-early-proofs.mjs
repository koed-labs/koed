// Assertion-level inventory for the approved S01–S14/N1.S/N3.S map.
// A clause names an executable owning proof, not a pass for the whole ID.
// Consumers must run the owning command fresh and verify the report/proof ID.
const proof = (key, runner, reportPath, proofId) => ({
  key,
  runner: `apps/desktop/scripts/${runner}`,
  reportPath: `scratch/${reportPath}`,
  proofId
});

export const earlyProofs = [
  {
    id: "S01.1",
    clauses: [
      proof(
        "activity/source/key/no-3-of-5",
        "validate-hq207.mjs",
        "hq-207/browser-report.json",
        "S01.1"
      )
    ],
    gaps: []
  },
  {
    id: "S01.3",
    clauses: [
      proof(
        "Needs you and Working now groups",
        "validate-hq207.mjs",
        "hq-207/browser-report.json",
        "S01.1"
      ),
      proof(
        "shared indicator and roster",
        "validate-hq701.mjs",
        "hq-701/HQ701.native.json",
        "HQ701.native"
      ),
      proof(
        "all four Shared Project Work Item groups and Project conversation on the right",
        "validate-hq703.mjs",
        "hq-703/HQ703.native.json",
        "S01.3.four-groups-project-chat"
      )
    ],
    gaps: []
  },
  {
    id: "S01.4",
    clauses: [
      proof(
        "Team message text absent from retained assistant row",
        "validate-hq505.mjs",
        "hq-505/HQ505.native.json",
        "S01.4.no-team-text-in-retained-reply"
      ),
      proof(
        "separate deterministic unread line",
        "validate-hq505.mjs",
        "hq-505/HQ505.native.json",
        "S01.4.deterministic-team-unread-line"
      )
    ],
    gaps: []
  },
  {
    id: "S02.1",
    clauses: [
      proof(
        "live Work Item brief",
        "validate-hq404.mjs",
        "hq-404/browser-report.json",
        "HQ404.native"
      ),
      proof(
        "trusted Conversation-origin row, brief, source link and close",
        "validate-hq901-work-origin.mjs",
        "hq-901-work-origin/report.json",
        "S02.1.origin-row-brief-link-close"
      )
    ],
    gaps: []
  },
  {
    id: "S03.1",
    clauses: [
      proof(
        "privacy note",
        "validate-hq711.mjs",
        "hq-711/HQ711.native.json",
        "S03.1.privacy-note"
      ),
      proof(
        "no colleague chat link",
        "validate-hq711.mjs",
        "hq-711/HQ711.native.json",
        "S03.1.no-colleague-chat-link"
      ),
      proof(
        "Needs you group, public step, exact PR URL and no private execution identity",
        "validate-hq711.mjs",
        "hq-711/HQ711.native.json",
        "S03.1.safe-status-step-pr"
      ),
      proof(
        "colleague private chat sentinel absent from item and document",
        "validate-hq711.mjs",
        "hq-711/HQ711.native.json",
        "S03.1.private-colleague-sentinel"
      )
    ],
    gaps: []
  },
  {
    id: "S04.1",
    clauses: [
      proof(
        "send to Quinn and Working now",
        "validate-hq404.mjs",
        "hq-404/browser-report.json",
        "HQ404.native"
      ),
      proof(
        "PR and Needs you",
        "validate-hq405.mjs",
        "hq-405/browser-report.json",
        "S04.1.pr-needs-you"
      ),
      proof(
        "same Work Item send, working, PR and Needs you",
        "validate-hq901-work-ticket-loop.mjs",
        "hq-901-work-ticket-loop/report.json",
        "S04.1.same-item-send-working-pr-needs-you"
      )
    ],
    gaps: []
  },
  {
    id: "S04.2",
    clauses: [
      proof(
        "Native exact card and approval callback",
        "validate-hq901-work-native.mjs",
        "hq-901-work-native/report.json",
        "S04.2.native-exact-review-card"
      ),
      proof(
        "Full access typed merge still reaches Native approval card",
        "validate-hq901-work-typed-native.mjs",
        "hq-901-work-typed-native/report.json",
        "S04.2.full-access-native-card"
      )
    ],
    gaps: []
  },
  {
    id: "S04.3",
    clauses: [
      proof(
        "Done follows simulated provider merged result and Work Item reconciliation",
        "validate-hq405.mjs",
        "hq-405/browser-report.json",
        "S04.3.provider-merged-before-done"
      ),
      proof(
        "same Work Item follows provider result to Done",
        "validate-hq901-work-ticket-loop.mjs",
        "hq-901-work-ticket-loop/report.json",
        "S04.3.same-item-provider-result-before-done"
      ),
      proof(
        "typed merge passes Native approval and provider result before Done",
        "validate-hq901-work-typed-native.mjs",
        "hq-901-work-typed-native/report.json",
        "S05.2.typed-tool-native-provider-done"
      )
    ],
    gaps: []
  },
  {
    id: "S04.4",
    requires: ["N9.U"],
    clauses: [
      proof(
        "ticket closing reply cites newly created Memory after provider merge",
        "validate-hq901-work-closing-citation.mjs",
        "hq-901-work-closing-citation/report.json",
        "S04.4.ticket-closing-reply-new-memory-citation"
      )
    ],
    scopeNotes: [
      "The S fixture supplies the agent closing reply and new Memory. Required N9.U separately proves normal production capture and durable citation storage; Koed does not synthesize a closing reply in the backend."
    ],
    gaps: []
  },
  {
    id: "S05.1",
    requires: ["N1.U"],
    clauses: [
      proof(
        "rendered catch-up excludes finished ticket and PR sentinels",
        "validate-hq901-work-catchup.mjs",
        "hq-901-work-catchup/report.json",
        "S05.1.rendered-catchup-excludes-pr-and-finished"
      )
    ],
    scopeNotes: [
      "The S fixture supplies the AI Client reply. Required N1.U separately verifies the production catch-up input excludes finished work and merged PRs."
    ],
    gaps: []
  },
  {
    id: "S05.2",
    clauses: [
      proof(
        "declined proposal remains In review",
        "validate-hq405.mjs",
        "hq-405/browser-report.json",
        "S05.2.decline-remains-in-review"
      ),
      proof(
        "typed Merge #212 reaches rendered merge outcome",
        "validate-hq901-work-typed-merge.mjs",
        "hq-901-work-typed-merge/report.json",
        "S05.2.typed-rendered-proposal-merge-done"
      ),
      proof(
        "worker tool receipt reaches Native review",
        "validate-hq901-work-native.mjs",
        "hq-901-work-native/report.json",
        "S05.2.tool-receipt-native-merged"
      ),
      proof(
        "typed Merge #212 produces worker receipt, Native approval and provider merged result",
        "validate-hq901-work-typed-native.mjs",
        "hq-901-work-typed-native/report.json",
        "S05.2.typed-tool-native-provider-done"
      )
    ],
    gaps: []
  },
  {
    id: "S06.1",
    requires: ["N13.U"],
    clauses: [
      proof(
        "selected Plan.md document action dispatch",
        "validate-hq406.mjs",
        "hq-406/native-report.json",
        "HQ406.native"
      ),
      proof(
        "offered, typed and document to-do tool receipts retain exact leased selector",
        "validate-hq901-work-text-receipts.mjs",
        "hq-901-work-text-receipts/report.json",
        "S06.1.offered-typed-document-tool-receipts"
      ),
      proof(
        "selected document action creates three Work Items and repeat creates zero",
        "validate-hq901-work-document-cycle.mjs",
        "hq-901-work-document-cycle/report.json",
        "S06.1.document-ui-tool-three-repeat-zero"
      ),
      proof(
        "offered Make 3 action creates three Work Items and repeat creates zero",
        "validate-hq901-work-document-cycle.mjs",
        "hq-901-work-document-cycle/report.json",
        "S06.1.offered-ui-tool-three-repeat-zero"
      ),
      proof(
        "typed document request creates three Work Items and repeat creates zero",
        "validate-hq901-work-document-cycle.mjs",
        "hq-901-work-document-cycle/report.json",
        "S06.1.typed-ui-tool-three-repeat-zero"
      )
    ],
    scopeNotes: [
      "The S journey uses simulated API inventory. Required N13.U also runs the real three-item document creation and repeat-idempotence test."
    ],
    gaps: []
  },
  {
    id: "S07.1",
    clauses: [
      proof(
        "persisted alias numbers open beside the chat after reload",
        "validate-hq306.mjs",
        "hq-306/browser-report.json",
        "S07.1"
      )
    ],
    gaps: []
  },
  {
    id: "S08.1",
    requires: ["N3.S"],
    clauses: [
      proof(
        "ticketless colleague PR appears in Needs you",
        "validate-hq405.mjs",
        "hq-405/browser-report.json",
        "S08.1.ticketless-colleague-pr-visible"
      ),
      proof(
        "ticketless colleague PR approval removes Needs you",
        "validate-hq901-work-ticketless.mjs",
        "hq-901-work-ticketless/report.json",
        "S08.1.ticketless-colleague-pr-approved-removed"
      )
    ],
    scopeNotes: [
      "The S journey supplies the provider result; required N3.S proves Native review and its required N3.U companion verifies real policy and journal boundaries."
    ],
    gaps: []
  },
  {
    id: "S09.1",
    clauses: [
      proof(
        "skill and Source list with explanation",
        "validate-hq205.mjs",
        "hq-205/browser-report.json",
        "S09.1"
      )
    ],
    gaps: []
  },
  {
    id: "S10.1",
    clauses: [
      proof(
        "add and tick a To do",
        "validate-hq403.mjs",
        "hq-403/browser-report.json",
        "HQ403.native"
      ),
      proof(
        "send to Agent",
        "validate-hq404.mjs",
        "hq-404/browser-report.json",
        "HQ404.native"
      ),
      proof(
        "typed to-do and no-PR completion tool receipts",
        "validate-hq901-work-text-receipts.mjs",
        "hq-901-work-text-receipts/report.json",
        "S10.1.typed-todo-and-no-pr-complete-receipts"
      ),
      proof(
        "typed To do, handoff and no-PR completion render through worker receipts",
        "validate-hq901-work-todo-cycle.mjs",
        "hq-901-work-todo-cycle/report.json",
        "S10.1.typed-add-handoff-no-pr-completion"
      )
    ],
    gaps: []
  },
  {
    id: "S11.1",
    clauses: [
      proof(
        "context/Q&A, Escape/close, fold, hide/show",
        "validate-hq207.mjs",
        "hq-207/browser-report.json",
        "S11.1"
      )
    ],
    gaps: []
  },
  {
    id: "S12.1",
    clauses: [
      proof(
        "Scheduled summary, expansion, Job Needs you and navigation",
        "validate-hq603.mjs",
        "hq-603/HQ603.native.json",
        "HQ603.native"
      ),
      proof(
        "Now cross-Project lists, five-row caps, folds, and Project row navigation",
        "validate-hq901-now.mjs",
        "hq-901-now/report.json",
        "S12.1.now-cross-project-caps-folds-navigation"
      )
    ],
    gaps: []
  },
  {
    id: "S13.1",
    requires: ["N1.S", "I13.1"],
    clauses: [
      proof(
        "pre-join summary-sharing disclosure",
        "validate-hq703.mjs",
        "hq-703/HQ703.native.json",
        "S13.1"
      ),
      proof(
        "accepted invitation joins shared Project and opens Team-grouped private HQ",
        "validate-hq703.mjs",
        "hq-703/HQ703.native.json",
        "S13.1.accepted-join"
      ),
      proof(
        "accepted join shows captured assistant welcome in private HQ without Team text",
        "validate-hq703.mjs",
        "hq-703/HQ703.native.json",
        "S13.1.private-welcome"
      )
    ],
    gaps: []
  },
  {
    id: "S14.1",
    clauses: [
      proof(
        "share sheet disclosure and roster",
        "validate-hq701.mjs",
        "hq-701/HQ701.native.json",
        "HQ701.native"
      ),
      proof(
        "exact share-sheet contents before confirmation",
        "validate-hq901-early-share.mjs",
        "hq-901-early-share/report.json",
        "S14.1.share-sheet-contents"
      ),
      proof(
        "addressed invitation scope and Native decisions",
        "validate-hq703.mjs",
        "hq-703/HQ703.native.json",
        "S14.1"
      ),
      proof(
        "typed email invitation through exact managed action and Native confirmation to accepted join",
        "validate-hq901-invites.mjs",
        "hq-901-invites/report.json",
        "S14.1.email-invite-join"
      ),
      proof(
        "single member-write access level in Native confirmation",
        "validate-hq901-invites.mjs",
        "hq-901-invites/report.json",
        "S14.1.single-access"
      )
    ],
    gaps: []
  },
  {
    id: "N1.S",
    requires: ["N1.U"],
    clauses: [
      proof(
        "Team text absent from rendered catch-up reply",
        "validate-hq505.mjs",
        "hq-505/HQ505.native.json",
        "S01.4.no-team-text-in-retained-reply"
      ),
      proof(
        "actual catch-up provider input with Team messages present",
        "validate-hq901-prompt-native.mjs",
        "hq-901-prompts/report.json",
        "N1.S.catch-up-input"
      ),
      proof(
        "actual Curated proposal review input with Team messages present",
        "validate-hq901-prompt-native.mjs",
        "hq-901-prompts/report.json",
        "N1.S.proposal-input"
      ),
      proof(
        "ordinary managed command provider input with Team messages present",
        "validate-hq901-prompt-native.mjs",
        "hq-901-prompts/report.json",
        "N1.S.agent-turn-input"
      )
    ],
    gaps: []
  },
  {
    id: "N3.S",
    requires: ["N3.U"],
    clauses: [
      proof(
        "one simulated merge request followed by provider reconciliation",
        "validate-hq405.mjs",
        "hq-405/browser-report.json",
        "S04.3.provider-merged-before-done"
      ),
      proof(
        "decline leaves In review",
        "validate-hq405.mjs",
        "hq-405/browser-report.json",
        "S05.2.decline-remains-in-review"
      ),
      proof(
        "Native method selector rejects unsupported request",
        "validate-hq901-work-native.mjs",
        "hq-901-work-native/report.json",
        "N3.S.native-method-selector-rejected"
      ),
      proof(
        "Native stale readiness requires a changed card",
        "validate-hq901-work-native.mjs",
        "hq-901-work-native/report.json",
        "N3.S.native-stale-result-requires-new-card"
      ),
      proof(
        "Native uncertainty uses read-only reconciliation",
        "validate-hq901-work-native.mjs",
        "hq-901-work-native/report.json",
        "N3.S.native-readonly-recovery"
      ),
      proof(
        "Full access typed orchestration still requires Native approval",
        "validate-hq901-work-typed-native.mjs",
        "hq-901-work-typed-native/report.json",
        "S04.2.full-access-native-card"
      )
    ],
    scopeNotes: [
      "Native journeys simulate the service/provider response; required N3.U separately verifies actual single-use journal, drift, policy and read-only uncertainty behavior."
    ],
    gaps: []
  }
];
