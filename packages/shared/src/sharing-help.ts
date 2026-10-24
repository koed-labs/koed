/** The version is a content contract. Keep the page and Chief instructions on this source. */
export const SHARING_HELP_VERSION = 1;

export const sharingHelpPoints = [
  {
    id: "P1",
    keptTrueBy: ["I14.1", "I713.12", "N8.I"],
    title: "What sharing a Project shares",
    text: "A shared Project gives its members its sources list, to-dos and Project memory. Each member's Project chats are shared as summaries according to that member's sharing setting, never as full transcripts. A full transcript needs separate consent. Eligible Project-scoped reviewed memories need group administrator opt-in, source-owner approval with an identity check, and supporting information from the exact shared chat. Me-scoped Personal Memory stays private. Source notes keep their separate grants. You choose whether each person can edit or only view."
  },
  {
    id: "P2",
    keptTrueBy: ["S17.4", "I713.06", "N8.I"],
    title: "Some things stay private",
    text: "Your Personal Memory and your private HQ Conversation with your Chief of Staff are not shared. After you make a chat private, anything you add stays private; its earlier shared summary stays in the Project."
  },
  {
    id: "P3",
    keptTrueBy: ["I713.12"],
    title: "How memory works",
    text: "Decisions and what agents learn in a Project go into that Project's memory for every agent in it. Your preferences stay in your own Personal Memory."
  },
  {
    id: "P4",
    keptTrueBy: ["I720.1", "I720.6", "N11.I"],
    title: "Who keeps what",
    text: "What people add to a Project, including chat summaries and documents, stays with the Project and its group if it has one. Removing someone stops their access and their agent's access, but does not delete what they added. Making a chat private or leaving stops future sharing; earlier shares stay. Shared memory still stops being used if its author asks Koed to forget it, when it expires, or if the Project owner removes it."
  },
  {
    id: "P5",
    keptTrueBy: ["S723.2", "I724.1", "I724.2"],
    title: "When your agent shares",
    text: "With Ask first, your Chief of Staff asks before inviting anyone. With Full access, it prepares the invitation for you; the required Native review still applies. Agent shares are flagged on Sharing and listed under Recently shared for 24 hours. There you can Remove access or Cancel invitation."
  }
] as const;

export const sharingHelpInstructions = [
  `Koed sharing help version ${SHARING_HELP_VERSION}. Answer how sharing works from these points, without reading Koed source code. Offer Open Sharing through koed_sharing_open. For the User's current sharing, call sharing_overview and mention every unavailable Team backend; unavailable means unknown, never absent. For a removal request, resolve each person to exact IDs within each backend, show the selected backend-qualified Project, Workspace, invitation, or Team targets for human review, and call sharing_remove with those exact targets. Do not join people by display name across backends or guess an invitation recipient from a name. Ask for a narrow identity clarification when needed. If any backend is unavailable or a scope is ambiguous, say which access remains unknown. Never claim literally all access was removed unless the complete known scope was verified. Wait for each required human review and its final receipt.`,
  ...sharingHelpPoints.map(
    (point) => `${point.id} ${point.title}: ${point.text}`
  )
].join("\n");
