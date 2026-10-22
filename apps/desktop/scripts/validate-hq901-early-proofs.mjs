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
    id: "S01.2",
    clauses: [],
    gaps: ["Three exact Team-chip hide/show checks belong to the HQ-705 owner."]
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
      )
    ],
    gaps: [
      "Shared Project does not yet have assertions for all four groups and its Project chat on the right; current proofs only cover Needs you/Working now and shared identity separately."
    ]
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
      )
    ],
    gaps: [
      "Keyless Work Items already have a brief and live log. The Conversation-origin producer and row origin/activity description and readable origin link remain incomplete or unproved; closing back to chat also needs its journey assertion; an unrelated unlinked runtime is not required by S02.1."
    ]
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
      )
    ],
    gaps: [
      "No sentinel proves arbitrary colleague chat content absent from the item; the real two-user source boundary is I03.1."
    ]
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
      )
    ],
    gaps: [
      "The same Work Item is not observed transitioning from send to PR creation to Needs you; HQ404 and HQ405 fixtures use different items."
    ]
  },
  {
    id: "S04.2",
    clauses: [],
    gaps: [
      "The exact Native card facts and the same card in Full access still need an executable Native bridge proof."
    ]
  },
  {
    id: "S04.3",
    clauses: [
      proof(
        "Done follows simulated provider merged result and Work Item reconciliation",
        "validate-hq405.mjs",
        "hq-405/browser-report.json",
        "S04.3.provider-merged-before-done"
      )
    ],
    gaps: [
      "The HQ-405 renderer fixture does not expose an actual Native approval decision before this merge; the production Native callback needs its own proof."
    ]
  },
  {
    id: "S04.4",
    clauses: [],
    gaps: [
      "The ticket Conversation closing reply has no assertion for its newly created Memory citation."
    ]
  },
  {
    id: "S05.1",
    clauses: [],
    gaps: [
      "API filtering is unit-tested, but the rendered catch-up has no forbidden PR/finished-ticket sentinel proof."
    ]
  },
  {
    id: "S05.2",
    clauses: [
      proof(
        "declined proposal remains In review",
        "validate-hq405.mjs",
        "hq-405/browser-report.json",
        "S05.2.decline-remains-in-review"
      )
    ],
    gaps: [
      "No proof connects typed Merge #212 to the worker review_request_merge_propose receipt and its Native approval, provider merged result, and KOE-4 completion."
    ]
  },
  {
    id: "S06.1",
    clauses: [
      proof(
        "selected Plan.md document action dispatch",
        "validate-hq406.mjs",
        "hq-406/native-report.json",
        "HQ406.native"
      )
    ],
    gaps: [
      "The fixture lacks offered/typed/document tool receipts creating three Work Items; the existing API integration proves repeat apply idempotence for one item only."
    ]
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
    clauses: [
      proof(
        "ticketless colleague PR appears in Needs you",
        "validate-hq405.mjs",
        "hq-405/browser-report.json",
        "S08.1.ticketless-colleague-pr-visible"
      )
    ],
    gaps: [
      "Approval removing that PR from Needs you is not asserted in a Native scenario."
    ]
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
      )
    ],
    gaps: [
      "No-PR completion through work_item_complete, typed koed_todo_add, and the offer to hand it to an Agent are not asserted."
    ]
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
      )
    ],
    gaps: [
      "Now cross-Project Needs you, five-row caps, folds, no crew/timeline, and Project row navigation need consolidated machine proof."
    ]
  },
  {
    id: "S13.1",
    clauses: [
      proof(
        "pre-join summary-sharing disclosure",
        "validate-hq703.mjs",
        "hq-703/HQ703.native.json",
        "S13.1"
      )
    ],
    gaps: [
      "HQ703 fixture lacks sharedJoinProject; no accepted join opens HQ or proves Team-text-free welcome, grouped sidebar, Ana review, and private HQ chat."
    ]
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
      )
    ],
    gaps: [
      "Email invitation through join, single access level, and koed_team_invite text confirmation remain unproved."
    ]
  },
  {
    id: "N1.S",
    clauses: [
      proof(
        "Team text absent from rendered catch-up reply",
        "validate-hq505.mjs",
        "hq-505/HQ505.native.json",
        "S01.4.no-team-text-in-retained-reply"
      )
    ],
    gaps: [
      "No sentinel spy covers catch-up prompt, memory proposals, and agent turns with Team messages present."
    ]
  },
  {
    id: "N3.S",
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
      )
    ],
    gaps: [
      "Full-access Native review, changed head/check reapproval, method policy, duplicate dispatch, and read-only uncertain reconciliation need separate executable assertions."
    ]
  }
];
