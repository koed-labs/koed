// Desktop-side assertion inventory for approved S15–S30 and N6.S/N7.S.
// A clause identifies a fresh executable proof. It does not turn a partial
// ticket proof into a pass for every assertion in the approved compound case.
// Real API/Team and unit clauses are owned by scripts/hq-acceptance-owned-suites.mjs.
const proof = (key, runner, reportPath, proofId) => ({
  key,
  runner: `apps/desktop/scripts/${runner}`,
  reportPath: `scratch/${reportPath}`,
  proofId
});

export const lateProofs = [
  {
    id: "S01.2",
    clauses: [
      proof(
        "Team chip absent with visible column, present when hidden, and toggles again",
        "validate-hq705.mjs",
        "hq-705/HQ705.native.json",
        "S01.2"
      )
    ],
    gaps: []
  },
  {
    id: "S15.1",
    clauses: [
      proof(
        "private chat drag and local placement",
        "validate-hq107.mjs",
        "hq-107/browser-report.json",
        "HQ107.private-native"
      ),
      proof(
        "moved-in shared chat receives separate summary offer",
        "validate-hq702.mjs",
        "hq-702/HQ702.native.json",
        "HQ702.ui.native"
      )
    ],
    gaps: [
      "The current sidebar has no named Koed team heading, so approved Just me / Shared / Koed team order cannot be proved."
    ]
  },
  {
    id: "S15.2",
    requires: ["N2.I"],
    clauses: [
      proof(
        "exact summary question and Native approve/cancel",
        "validate-hq702.mjs",
        "hq-702/HQ702.native.json",
        "S15.2"
      )
    ],
    gaps: []
  },
  {
    id: "S15.3",
    clauses: [
      proof(
        "confirmed summary status after Share again",
        "validate-hq702.mjs",
        "hq-702/HQ702.native.json",
        "HQ702.ui.native"
      )
    ],
    gaps: [
      "No shared-with-member toast or exact Team visibility assertion exists for the moved chat; the named Koed team sidebar fold is absent in production."
    ]
  },
  {
    id: "S16.1",
    clauses: [
      proof(
        "shared Project roster in Who’s in sheet",
        "validate-hq701.mjs",
        "hq-701/HQ701.native.json",
        "HQ701.native"
      )
    ],
    gaps: [
      "Five loose chats plus Show 2 more and the text question ‘Who’s in Koed team?’ have no dedicated native assertions."
    ]
  },
  {
    id: "S17.1",
    clauses: [
      proof(
        "Just me/Team tabs, unread, exact Team audience",
        "validate-hq705.mjs",
        "hq-705/HQ705.native.json",
        "S17.1"
      )
    ],
    gaps: []
  },
  {
    id: "S17.2",
    clauses: [
      proof(
        "human-only Team disclosure and no decision marks",
        "validate-hq705.mjs",
        "hq-705/HQ705.native.json",
        "S17.2"
      )
    ],
    gaps: []
  },
  {
    id: "S17.3",
    clauses: [
      proof(
        "people-only picker excludes Agent",
        "validate-hq705.mjs",
        "hq-705/HQ705.native.json",
        "S17.3"
      )
    ],
    gaps: []
  },
  {
    id: "S17.4",
    clauses: [
      proof(
        "Team history hidden in private HQ tab",
        "validate-hq705.mjs",
        "hq-705/HQ705.native.json",
        "S17.4"
      )
    ],
    gaps: []
  },
  {
    id: "S18.1",
    clauses: [
      proof(
        "grouped What Koed knows, replacement detail, Forget control",
        "validate-hq307.mjs",
        "hq-307/browser-report.json",
        "S18.1"
      )
    ],
    gaps: []
  },
  {
    id: "S18.2",
    clauses: [
      proof(
        "Me-private disclosure, legacy unscoped exclusion, Forget/Undo",
        "validate-hq304.mjs",
        "hq-304/browser-report.json",
        "S18.2"
      )
    ],
    gaps: []
  },
  {
    id: "S18.3",
    clauses: [
      proof(
        "Learned today expansion and count after Forget/Undo",
        "validate-hq305.mjs",
        "hq-305/HQ305.native.json",
        "HQ305.native"
      )
    ],
    gaps: [
      "Text ‘forget that’ selecting the latest owned cited assertion and returning to Now is not asserted in this browser flow."
    ]
  },
  {
    id: "S19.1",
    clauses: [
      proof(
        "HQ and Needs you row Memory chips open reauthorized detail",
        "validate-hq308.mjs",
        "hq-308/HQ308.native.json",
        "HQ308.native"
      )
    ],
    gaps: []
  },
  {
    id: "S19.2",
    clauses: [
      proof(
        "ordinary chat citation renders and resolves",
        "validate-hq306.mjs",
        "hq-306/browser-report.json",
        "S07.1"
      )
    ],
    gaps: [
      "The cited chat is not proved loose/Just me and this proof does not assert sidebar scroll retention."
    ]
  },
  {
    id: "S19.3",
    clauses: [],
    gaps: [
      "Personal koed-mobile Project Delete/Undo and citation resolution after deletion have no executable browser proof."
    ]
  },
  {
    id: "S19.4",
    clauses: [
      proof(
        "owner text leave routes to separate Delete review",
        "validate-hq704.mjs",
        "hq-704/HQ704.native.json",
        "S19.4.ui"
      )
    ],
    gaps: []
  },
  {
    id: "S20.1",
    clauses: [
      proof(
        "Just me group, Project, and nested chat visual indentation",
        "validate-hq107.mjs",
        "hq-107/browser-report.json",
        "S20.1.indentation"
      ),
      proof(
        "private visibility before message",
        "validate-hq711.mjs",
        "hq-711/HQ711.native.json",
        "HQ711.native"
      )
    ],
    gaps: []
  },
  {
    id: "S20.2",
    clauses: [
      proof(
        "Team leave review and new-invitation disclosure",
        "validate-hq704.mjs",
        "hq-704/HQ704.native.json",
        "S20.2"
      )
    ],
    gaps: []
  },
  {
    id: "S20.3",
    requires: ["I20.3", "I25.1"],
    clauses: [
      proof(
        "personal Project remains visible after Team leave",
        "validate-hq704.mjs",
        "hq-704/HQ704.native.json",
        "S20.3.ui"
      )
    ],
    gaps: []
  },
  {
    id: "S20.4",
    clauses: [
      proof(
        "no Undo on Team leave toast",
        "validate-hq704.mjs",
        "hq-704/HQ704.native.json",
        "S20.4"
      )
    ],
    gaps: []
  },
  {
    id: "N6.S",
    requires: ["N6.I"],
    clauses: [
      proof(
        "no leave Undo and metadata-only shared Project restore disclosure",
        "validate-hq704.mjs",
        "hq-704/HQ704.native.json",
        "N6.S.ui"
      )
    ],
    gaps: []
  },
  {
    id: "N7.S",
    requires: ["N7.U"],
    clauses: [
      proof(
        "separate Delete and Forget UI with retained-recall disclosure",
        "validate-hq106.mjs",
        "hq-106/browser-report.json",
        "HQ106.native"
      )
    ],
    gaps: []
  },
  {
    id: "S21.1",
    clauses: [
      proof(
        "viewer-local due ordering, Friday text, menu and Now states",
        "validate-hq407.mjs",
        "hq-407/HQ407.native.json",
        "HQ407.native"
      )
    ],
    gaps: [
      "Syllabus already-done response and Lena/Omar Team audience are not asserted in the Econ 101 browser sequence."
    ]
  },
  {
    id: "S22.1",
    requires: ["I26.1"],
    clauses: [
      proof(
        "deck flip, Again/Good count, generated Chapter 7 deck",
        "validate-hq803.mjs",
        "hq-803/browser-report.json",
        "S22.1.study"
      ),
      proof(
        "text-created deck opens",
        "validate-hq803.mjs",
        "hq-803/browser-report.json",
        "S22.1.text"
      )
    ],
    gaps: []
  },
  {
    id: "S23.1",
    clauses: [
      proof(
        "reply chip, Escape, one-line quote, jump and single list",
        "validate-hq707.mjs",
        "hq-707/HQ707.native.json",
        "S23.1"
      )
    ],
    gaps: []
  },
  {
    id: "S28.1",
    clauses: [
      proof(
        "two persisted alias numbers resolve after reload to distinct sources",
        "validate-hq306.mjs",
        "hq-306/browser-report.json",
        "S28.1"
      )
    ],
    gaps: []
  },
  {
    id: "S29.1",
    requires: ["U29.1"],
    clauses: [
      proof(
        "merge request followed by read-only reconciliation in renderer",
        "validate-hq405.mjs",
        "hq-405/browser-report.json",
        "HQ405.native"
      )
    ],
    gaps: []
  }
];
