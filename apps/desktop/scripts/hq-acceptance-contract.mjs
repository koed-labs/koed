// Approved assertion identities and scopes. This contract contains no test results.
export const hqAcceptanceContract = [
  {
    id: "S01.1",
    category: "positive",
    description:
      "Activity is not ticket progress; source/key-item affordance; no 3/5 counter",
    owners: ["HQ-205", "HQ-206", "HQ-207"],
    harness: "simulated-ipc"
  },
  {
    id: "S01.2",
    category: "positive",
    description:
      "Team chip only when the chat column is hidden; all three mapped checks",
    owners: ["HQ-207", "HQ-705"],
    harness: "simulated-ipc"
  },
  {
    id: "S01.3",
    category: "positive",
    description:
      "Shared indicator, need/doing/review/done groups, Project chat placement",
    owners: ["HQ-204", "HQ-207", "HQ-403", "HQ-701", "HQ-705"],
    harness: "simulated-ipc"
  },
  {
    id: "S01.4",
    category: "positive",
    description:
      "Catch-up contains no Team text; deterministic unread-count line appears when appropriate",
    owners: ["HQ-206", "HQ-505", "HQ-705"],
    harness: "simulated-ipc"
  },
  {
    id: "S02.1",
    category: "positive",
    description: "Origin, live log, work brief, back navigation",
    owners: ["HQ-403", "HQ-404"],
    harness: "simulated-ipc"
  },
  {
    id: "S03.1",
    category: "positive",
    description:
      "Privacy note and no colleague-chat link; item shows only safe progress (status, step, PR link), with no chat content",
    owners: ["HQ-404", "HQ-405", "HQ-711"],
    harness: "simulated-ipc"
  },
  {
    id: "I03.1",
    category: "positive",
    description:
      "Integration verifies the real boundary: privacy note, no colleague-chat link, and safe progress without chat content",
    owners: ["HQ-713"],
    harness: "real-api"
  },
  {
    id: "S04.1",
    category: "positive",
    description: "Send to agent, Working now, PR, Needs you state",
    owners: ["HQ-404", "HQ-405"],
    harness: "simulated-ipc"
  },
  {
    id: "S04.2",
    category: "positive",
    description:
      "Koed approval names repo, PR, target, head, method, checks; same in Full access",
    owners: ["HQ-405"],
    harness: "simulated-ipc"
  },
  {
    id: "S04.3",
    category: "positive",
    description:
      "Done only after approval and simulated provider `merged` result",
    owners: ["HQ-405"],
    harness: "simulated-ipc"
  },
  {
    id: "S04.4",
    category: "positive",
    description: "Closing ticket reply cites the new memory",
    owners: ["HQ-306", "HQ-405"],
    harness: "simulated-ipc"
  },
  {
    id: "S05.1",
    category: "positive",
    description: "Catch-up does not repeat PRs or finished tickets",
    owners: ["HQ-206", "HQ-405", "HQ-505"],
    harness: "simulated-ipc"
  },
  {
    id: "S05.2",
    category: "positive",
    description:
      "Text proposal, same approval, merged completion; decline leaves In review",
    owners: ["HQ-405", "HQ-408", "HQ-504"],
    harness: "simulated-ipc"
  },
  {
    id: "S06.1",
    category: "positive",
    description:
      "Plan.md creates three tickets through offered, typed, and document paths; second run adds nothing",
    owners: ["HQ-209", "HQ-406", "HQ-504"],
    harness: "simulated-ipc"
  },
  {
    id: "S07.1",
    category: "positive",
    description:
      "Memory number in reply opens next to chat; citation still resolves after reload",
    owners: ["HQ-306"],
    harness: "simulated-ipc"
  },
  {
    id: "S08.1",
    category: "positive",
    description:
      "Colleague PR review without ticket; Needs you updates once approved",
    owners: ["HQ-405"],
    harness: "simulated-ipc"
  },
  {
    id: "S09.1",
    category: "positive",
    description: "Skills and sources are shown; added skill explained",
    owners: ["HQ-205", "HQ-209"],
    harness: "simulated-ipc"
  },
  {
    id: "S10.1",
    category: "positive",
    description: "To-do actions; completion is through `work_item_complete`",
    owners: ["HQ-401", "HQ-403", "HQ-404", "HQ-504"],
    harness: "simulated-ipc"
  },
  {
    id: "S11.1",
    category: "positive",
    description:
      "Context chip, HQ Q&A, Escape/close, fold and visibility controls",
    owners: ["HQ-104", "HQ-207"],
    harness: "simulated-ipc"
  },
  {
    id: "S12.1",
    category: "positive",
    description:
      "Now rows, overflow, cross-Project Needs you, folding, scheduled expansion, row navigation",
    owners: ["HQ-108", "HQ-603"],
    harness: "simulated-ipc"
  },
  {
    id: "S13.1",
    category: "positive",
    description: "Pre-join summary-sharing disclosure; no Team text in welcome",
    owners: [
      "HQ-103",
      "HQ-207",
      "HQ-403",
      "HQ-405",
      "HQ-505",
      "HQ-701",
      "HQ-703",
      "HQ-705"
    ],
    harness: "simulated-ipc"
  },
  {
    id: "I13.1",
    category: "positive",
    description:
      "Integration verifies the real join state after summary-sharing disclosure and welcome without Team text",
    owners: ["HQ-713"],
    harness: "real-api"
  },
  {
    id: "S14.1",
    category: "positive",
    description:
      "Email invitation, one access level, join, explanation of what invitees never receive, text share with confirmation, and share-sheet contents",
    owners: ["HQ-504", "HQ-701", "HQ-703"],
    harness: "simulated-ipc"
  },
  {
    id: "I14.1",
    category: "positive",
    description:
      "Integration verifies invitation, join, and share effects through the real API and Team Backend",
    owners: ["HQ-713"],
    harness: "real-api"
  },
  {
    id: "I724.2.data",
    category: "positive",
    description:
      "Accepted invitation links its backend-qualified Personal Conversation origin to the resulting Workspace Access composite and version; later grants and backend collisions retain earlier attribution, while Team never stores the Conversation id. This data contract excludes Sharing UI and access removal.",
    owners: ["HQ-721"],
    harness: "real-api"
  },
  {
    id: "S15.1",
    category: "positive",
    description:
      "Sidebar grouping and confirmation before sharing by moving a chat",
    owners: ["HQ-103", "HQ-107"],
    harness: "simulated-ipc"
  },
  {
    id: "S15.2",
    category: "positive",
    description: "Summary-sharing wording; no Conversation Source Access",
    owners: ["HQ-702"],
    harness: "simulated-ipc"
  },
  {
    id: "S15.3",
    category: "positive",
    description: "Share toast, Team visibility label, group folding",
    owners: ["HQ-103", "HQ-701", "HQ-702"],
    harness: "simulated-ipc"
  },
  {
    id: "S16.1",
    category: "positive",
    description:
      "Loose chats in Just me with overflow, workspace sheet, and “who's in” by text",
    owners: ["HQ-103", "HQ-504", "HQ-701"],
    harness: "simulated-ipc"
  },
  {
    id: "S17.1",
    category: "positive",
    description: "Just me/Team tabs, unread indicator, Team visibility label",
    owners: ["HQ-103", "HQ-705"],
    harness: "simulated-ipc"
  },
  {
    id: "S17.2",
    category: "positive",
    description: "Human-only Team message disclosure; no saved-decision mark",
    owners: ["HQ-705"],
    harness: "simulated-ipc"
  },
  {
    id: "S17.3",
    category: "positive",
    description: "`@Rook` offers people from the mention picker only",
    owners: ["HQ-705", "HQ-706"],
    harness: "simulated-ipc"
  },
  {
    id: "S17.4",
    category: "positive",
    description: "Private chat remains separate",
    owners: ["HQ-103", "HQ-702", "HQ-705"],
    harness: "simulated-ipc"
  },
  {
    id: "S18.1",
    category: "positive",
    description: "Memory grouping, replacement, Forget this control",
    owners: ["HQ-303", "HQ-304", "HQ-307"],
    harness: "simulated-ipc"
  },
  {
    id: "S18.2",
    category: "positive",
    description:
      "Me is not shared; legacy unscoped items do not appear under Me",
    owners: ["HQ-301", "HQ-302", "HQ-303", "HQ-304"],
    harness: "simulated-ipc"
  },
  {
    id: "S18.3",
    category: "positive",
    description:
      "Text “forget that” targets the User's own latest cited assertion; Now is home",
    owners: ["HQ-108", "HQ-306", "HQ-307", "HQ-504"],
    harness: "simulated-ipc"
  },
  {
    id: "S19.1",
    category: "positive",
    description: "HQ and Needs you rows show memory chips",
    owners: ["HQ-308"],
    harness: "simulated-ipc"
  },
  {
    id: "S19.2",
    category: "positive",
    description:
      "Loose chat citation is marked Just me; sidebar scroll remains stable",
    owners: ["HQ-103", "HQ-105", "HQ-306"],
    harness: "simulated-ipc"
  },
  {
    id: "S19.3",
    category: "positive",
    description: "Deleting koed-mobile preserves resolvable memory chips",
    owners: ["HQ-202", "HQ-208", "HQ-306", "HQ-308"],
    harness: "simulated-ipc"
  },
  {
    id: "S19.4",
    category: "positive",
    description:
      "“Leave koed-main” identifies the User as owner and follows the explicit delete path",
    owners: ["HQ-208", "HQ-704"],
    harness: "simulated-ipc"
  },
  {
    id: "S20.1",
    category: "positive",
    description: "Indentation and visibility line before first message",
    owners: ["HQ-103", "HQ-105", "HQ-711"],
    harness: "simulated-ipc"
  },
  {
    id: "S20.2",
    category: "positive",
    description:
      "Team-leave confirmation says a new invite is needed to return",
    owners: ["HQ-704"],
    harness: "simulated-ipc"
  },
  {
    id: "S20.3",
    category: "positive",
    description:
      "Workspace removal with Personal Project and to-dos retained after copy-back",
    owners: ["HQ-704", "HQ-712"],
    harness: "simulated-ipc"
  },
  {
    id: "I20.3",
    category: "positive",
    description:
      "Integration verifies copy-back and backend effects through the real API and Team Backend",
    owners: ["HQ-713"],
    harness: "real-api"
  },
  {
    id: "S20.4",
    category: "positive",
    description: "No Undo button on leave toast",
    owners: ["HQ-704"],
    harness: "simulated-ipc"
  },
  {
    id: "S21.1",
    category: "positive",
    description: "Econ 101 deadlines/order/menu/Now states",
    owners: ["HQ-209", "HQ-402", "HQ-407"],
    harness: "simulated-ipc"
  },
  {
    id: "U21.1",
    category: "positive",
    description:
      "The same `due_on` reads “Due tomorrow” for a viewer in another time zone on that calendar day",
    owners: ["HQ-402 unit suite"],
    harness: "unit"
  },
  {
    id: "S22.1",
    category: "positive",
    description:
      "Shared deck interaction; Again learning is saved to that person's Me memory",
    owners: ["HQ-504", "HQ-802", "HQ-803"],
    harness: "simulated-ipc"
  },
  {
    id: "S23.1",
    category: "positive",
    description: "Quote chip, Escape, one-line quote, jump, no threads",
    owners: ["HQ-705", "HQ-707"],
    harness: "simulated-ipc"
  },
  {
    id: "I24.1",
    category: "positive",
    description:
      "Chat/source/Project deletion and leave freeze published material for recall, exclude later messages/revisions, keep a leaver's material inspectable by remaining members, and do not resume after restore",
    owners: ["HQ-715", "HQ-713 integration suite"],
    harness: "real-api"
  },
  {
    id: "I25.1",
    category: "positive",
    description:
      "Leave copy-back retry/interruption and last-owner refusal before side effects",
    owners: ["HQ-704", "HQ-712", "HQ-713 integration suite"],
    harness: "real-api"
  },
  {
    id: "I26.1",
    category: "positive",
    description: "Shared cards and per-person progress/Again-to-Me",
    owners: ["HQ-801", "HQ-803", "HQ-713 integration suite"],
    harness: "real-api"
  },
  {
    id: "I27.1",
    category: "positive",
    description: "Curated exact provenance/scope and invalidation",
    owners: ["HQ-301", "HQ-302", "HQ-702", "HQ-713 integration suite"],
    harness: "real-api"
  },
  {
    id: "S28.1",
    category: "positive",
    description: "Multiple citations reload from aliases",
    owners: ["HQ-306", "HQ-714"],
    harness: "simulated-ipc"
  },
  {
    id: "I28.1",
    category: "positive",
    description: "Team details reauthorize after revocation",
    owners: ["HQ-306", "HQ-714", "HQ-713 integration suite"],
    harness: "real-api"
  },
  {
    id: "S29.1",
    category: "positive",
    description:
      "Changed checks conflict; unknown dispatch is recovered read-only without retry",
    owners: ["HQ-405", "HQ-408"],
    harness: "simulated-ipc"
  },
  {
    id: "U29.1",
    category: "positive",
    description:
      "Changed checks conflict; unknown dispatch is recovered read-only without retry",
    owners: ["HQ-408 unit suite"],
    harness: "unit"
  },
  {
    id: "I30.1",
    category: "positive",
    description:
      "Combined selectors: linked Project + Me only; Team global Workspace search with no personal project id",
    owners: ["HQ-714", "HQ-713 integration suite"],
    harness: "real-api"
  },
  {
    id: "N1.S",
    category: "negative",
    description:
      "Team message sentinel never reaches catch-up, memory proposals, or agent turns",
    owners: ["HQ-505", "HQ-705"],
    harness: "simulated-ipc"
  },
  {
    id: "N1.U",
    category: "negative",
    description:
      "Team message sentinel never reaches memory proposals or agent turns",
    owners: ["D2 boundary unit suite"],
    harness: "unit"
  },
  {
    id: "N2.I",
    category: "negative",
    description:
      "Project Share Policy never creates Conversation Source Access",
    owners: ["HQ-713 integration suite"],
    harness: "real-api"
  },
  {
    id: "N3.S",
    category: "negative",
    description:
      "Native approval in Full access, changed-state reapproval, repository method policy, duplicate and unknown-dispatch behavior",
    owners: ["HQ-405", "HQ-408"],
    harness: "simulated-ipc"
  },
  {
    id: "N3.U",
    category: "negative",
    description:
      "Native approval in Full access, changed-state reapproval, repository method policy, duplicate and unknown-dispatch behavior",
    owners: ["HQ-405/HQ-408 unit suites"],
    harness: "unit"
  },
  {
    id: "N4.U",
    category: "negative",
    description: "AI Client process gets no source-control credentials",
    owners: ["HQ-408 unit suite"],
    harness: "unit"
  },
  {
    id: "N5.I",
    category: "negative",
    description: "Owner cannot grant another member's Conversation",
    owners: ["HQ-713 integration suite"],
    harness: "real-api"
  },
  {
    id: "N6.S",
    category: "negative",
    description:
      "No Undo for leave; restore after shared-Project deletion does not recreate access",
    owners: ["HQ-704"],
    harness: "simulated-ipc"
  },
  {
    id: "N6.I",
    category: "negative",
    description:
      "Restore after shared-Project deletion does not recreate access",
    owners: ["HQ-713 integration suite"],
    harness: "real-api"
  },
  {
    id: "N7.S",
    category: "negative",
    description: "Chat deletion retains recall; explicit forget removes it",
    owners: ["HQ-202", "HQ-208"],
    harness: "simulated-ipc"
  },
  {
    id: "N7.U",
    category: "negative",
    description: "Chat deletion retains recall; explicit forget removes it",
    owners: ["HQ-202/HQ-208 unit suites"],
    harness: "unit"
  },
  {
    id: "N8.I",
    category: "negative",
    description:
      "Curated positive control plus Me/unscoped/mixed-session/non-Conversation exclusions",
    owners: ["HQ-713 integration suite"],
    harness: "real-api"
  },
  {
    id: "N9.U",
    category: "negative",
    description: "Closing without merge never marks a Work Item done",
    owners: ["HQ-405 unit suite"],
    harness: "unit"
  },
  {
    id: "N10.U",
    category: "negative",
    description: "Two devices never execute the same scheduled lease",
    owners: ["HQ-602 unit suite"],
    harness: "unit"
  },
  {
    id: "N11.T",
    category: "negative",
    description:
      "Freeze/publication race, another grant still advances, revocation/suppression/expiry still deny",
    owners: ["HQ-715 Team repository suite"],
    harness: "team-repository"
  },
  {
    id: "N11.I",
    category: "negative",
    description:
      "Freeze retains Project summaries against author revoke; independent revoke, suppression and expiry still deny",
    owners: ["HQ-713 integration suite"],
    harness: "real-api"
  },
  {
    id: "N12.U",
    category: "negative",
    description:
      "Ownership checked before forget mutation; explicit/latest teammate citation never falls back to older owned assertion; ambiguous reference asks",
    owners: ["HQ-306", "HQ-307", "HQ-504 unit suites"],
    harness: "unit"
  },
  {
    id: "N13.U",
    category: "negative",
    description:
      "Project Source trash is independent of Note revision forget; no source `personal_deleted_at`; retries do not duplicate revisions/events",
    owners: ["HQ-209 unit suite"],
    harness: "unit"
  },
  {
    id: "I713.01",
    category: "two-user",
    description:
      "Alice shares Project “landing” with Bob; the share sheet lists docs, to-dos, and summaries",
    owners: ["HQ-713 real API/Team Backend suite"],
    harness: "two-user"
  },
  {
    id: "I713.02",
    category: "two-user",
    description:
      "Bob accepts; the join card states summary sharing; his sidebar shows “landing” under Shared and his HQ remains private",
    owners: ["HQ-713 real API/Team Backend suite"],
    harness: "two-user"
  },
  {
    id: "I713.03",
    category: "two-user",
    description:
      "Alice's Project chat is shared as a summary; Bob's recall finds it with a Team citation and no transcript is reachable",
    owners: ["HQ-713 real API/Team Backend suite"],
    harness: "two-user"
  },
  {
    id: "I713.04",
    category: "two-user",
    description:
      "Bob adds a to-do and Alice sees it live; conflicting title edits produce one conflict notice without data loss",
    owners: ["HQ-713 real API/Team Backend suite"],
    harness: "two-user"
  },
  {
    id: "I713.05",
    category: "two-user",
    description:
      "Bob sends a to-do to his agent; Alice sees status and step only",
    owners: ["HQ-713 real API/Team Backend suite"],
    harness: "two-user"
  },
  {
    id: "I713.06",
    category: "two-user",
    description:
      "Alice makes a chat private; its earlier summary stays in Bob's recall and later messages are not shared",
    owners: ["HQ-713 real API/Team Backend suite"],
    harness: "two-user"
  },
  {
    id: "N26",
    category: "two-user",
    description:
      "Make private settles after one freeze, share again creates the next exact freeze target, and multiple historical frozen grants remain settled",
    owners: [
      "HQ-720 Project share policy freeze suite",
      "HQ-713 real API/Team Backend suite"
    ],
    harness: "two-user"
  },
  {
    id: "I713.07",
    category: "two-user",
    description:
      "With Bob offline and the backend blocked, the Project is read-only and shows the offline notice",
    owners: ["HQ-713 real API/Team Backend suite"],
    harness: "two-user"
  },
  {
    id: "I713.08",
    category: "two-user",
    description:
      "Alice deletes the Project; it disappears for Bob, Bob's recall retains already-shared material, his own chats move to Just me, and their grants freeze at the last published closure so later messages/revisions are excluded",
    owners: ["HQ-713 real API/Team Backend suite"],
    harness: "two-user"
  },
  {
    id: "I713.09",
    category: "two-user",
    description:
      "Alice restores the Project; records/thread return, Bob's chats stay where they are, and frozen grants do not resume",
    owners: ["HQ-713 real API/Team Backend suite"],
    harness: "two-user"
  },
  {
    id: "I713.10",
    category: "two-user",
    description:
      "A second share run interrupted after step 2 of ADR 0062's copy resumes without duplicates",
    owners: ["HQ-713 real API/Team Backend suite"],
    harness: "two-user"
  },
  {
    id: "I713.11",
    category: "two-user",
    description:
      "Bob leaves after sharing a Conversation; Alice can inspect Bob's published frozen material but not later messages, Bob loses access to Alice's Team memory, and leaving one Project alone preserves his global Team membership",
    owners: ["HQ-713 real API/Team Backend suite"],
    harness: "two-user"
  },
  {
    id: "I713.12",
    category: "two-user",
    description:
      "With Curated enabled, Alice sees Bob's Project assertion only when all active direct sources are within the exact granted session; she sees its summary but not Bob's Me/unscoped/mixed-session assertions. Scope change invalidates the Team representation before commit. HQ-714 returns linked Project context plus Me without other Projects; Team inputs use `search_domain=global`, trusted Workspace/backend IDs, and no personal `project_id`.",
    owners: ["HQ-713 real API/Team Backend suite"],
    harness: "two-user"
  },
  {
    id: "I713.13",
    category: "two-user",
    description:
      "Alice and Bob study one shared deck; cards are common while progress and Again-to-Me learning differ by member",
    owners: ["HQ-713 real API/Team Backend suite"],
    harness: "two-user"
  },
  {
    id: "I713.14",
    category: "two-user",
    description:
      "Bob's owned-Project leave copy-back is interrupted and resumed idempotently; last-owner leave is refused before copy-back, and after ownership transfer successful copy plus version/authority revalidation precede removal",
    owners: ["HQ-713 real API/Team Backend suite"],
    harness: "two-user"
  },
  {
    id: "U520.1",
    category: "unit",
    description:
      "Official Codex and Claude usage readers preserve every reported bucket and restriction conservatively",
    owners: ["HQ-520"],
    harness: "unit"
  },
  {
    id: "U521.1",
    category: "positive",
    description:
      "HQ-521 U1: Settings Agents usage table shows provider rows, reported windows, distinct Codex buckets and restrictions",
    owners: ["HQ-521"],
    harness: "native-desktop"
  },
  {
    id: "U521.2",
    category: "positive",
    description:
      "HQ-521 U2: reported freshness, source and reset details with truthful Codex refresh outcomes",
    owners: ["HQ-521"],
    harness: "native-desktop"
  },
  {
    id: "U521.3",
    category: "positive",
    description:
      "HQ-521 U3: AI Client model menu shows usage and See usage opens Settings Agents",
    owners: ["HQ-521"],
    harness: "native-desktop"
  },
  {
    id: "N521.19",
    category: "unit",
    description:
      "HQ-521 N19: missing provider readings are unknown or not shared, never estimated",
    owners: ["HQ-521"],
    harness: "unit"
  },
  {
    id: "N521.24",
    category: "unit",
    description:
      "HQ-521 N24: passed resets and stale readings never show zero or qualify as fine",
    owners: ["HQ-521"],
    harness: "unit"
  },
  {
    id: "N521.34",
    category: "unit",
    description:
      "HQ-521 N34: provider buckets, restrictions, overage and unknown values stay conservative",
    owners: ["HQ-521"],
    harness: "unit"
  },
  {
    id: "N521.35",
    category: "unit",
    description:
      "HQ-521 N35: usage updates respect account authority, completion, refresh and unsubscribe",
    owners: ["HQ-521"],
    harness: "unit"
  },
  {
    id: "U520.2",
    category: "unit",
    description:
      "Runtime completion crosses a real Personal API stream into typed Desktop preload delivery",
    owners: ["HQ-520"],
    harness: "unit"
  },
  {
    id: "I520.1",
    category: "positive",
    description:
      "Two owners have isolated Personal usage while Team storage and reads contain none",
    owners: ["HQ-520", "HQ-713 integration suite"],
    harness: "real-api"
  },
  {
    id: "S520.1",
    category: "positive",
    description:
      "Native Desktop preload delivers only typed completion metadata and unsubscribes",
    owners: ["HQ-520"],
    harness: "simulated-ipc"
  },
  {
    id: "U722.1",
    category: "unit",
    description:
      "Sharing metadata reflects current Project/Team visibility and effective removal/cancellation authority.",
    owners: ["HQ-722"],
    harness: "unit"
  },
  {
    id: "N722.16",
    category: "unit",
    description:
      "Team sharing never includes Personal Conversation content/ids; Personal enrichment is current-owner bound.",
    owners: ["HQ-722"],
    harness: "unit"
  },
  {
    id: "N722.27",
    category: "unit",
    description:
      "A failed or unenrolled backend remains explicit beside available backends; live events queue a fresh read.",
    owners: ["HQ-722"],
    harness: "unit"
  },
  {
    id: "N722.33",
    category: "unit",
    description:
      "Cancellation capability follows current Team owner/admin authority, distinct from Project ownership.",
    owners: ["HQ-722"],
    harness: "unit"
  },
  {
    id: "U722.2",
    category: "unit",
    description:
      "Typed read-only Desktop IPC rejects untrusted senders and stale Personal authority.",
    owners: ["HQ-722"],
    harness: "unit"
  },
  {
    id: "I720.1",
    category: "two-user",
    description:
      "Project departure retains recall and the current Team byline.",
    owners: ["HQ-726"],
    harness: "two-user"
  },
  {
    id: "I720.2",
    category: "two-user",
    description:
      "Project chat and Note author revocation is refused while transcript access can be separately revoked.",
    owners: ["HQ-726"],
    harness: "two-user"
  },
  {
    id: "I720.3",
    category: "two-user",
    description:
      "Native-reviewed current Project owner removes exactly one frozen contribution with one replayable audited receipt.",
    owners: ["HQ-726"],
    harness: "two-user"
  },
  {
    id: "I720.4",
    category: "two-user",
    description: "Independent non-Project grants remain author-revocable.",
    owners: ["HQ-726"],
    harness: "two-user"
  },
  {
    id: "I720.5",
    category: "two-user",
    description:
      "Source metadata deletion hides/freezes its Note while retained content and other contributions stay independent.",
    owners: ["HQ-726"],
    harness: "two-user"
  },
  {
    id: "I720.6",
    category: "two-user",
    description:
      "Team departure retains others recall, updates attribution and denies the departed author.",
    owners: ["HQ-726"],
    harness: "two-user"
  },
  {
    id: "N726.14",
    category: "unit",
    description:
      "Only the current Project owner can remove exact contributions, with stale requests and author revokes failing closed.",
    owners: ["HQ-726"],
    harness: "unit"
  },
  {
    id: "N726.15",
    category: "unit",
    description:
      "Current Team departure denies author recall at the boundary while keeping published contributions.",
    owners: ["HQ-726"],
    harness: "unit"
  },
  {
    id: "N726.31",
    category: "unit",
    description:
      "Note-only canonical event fallback never exposes captured transcripts; Source metadata removal preserves its contribution.",
    owners: ["HQ-726"],
    harness: "unit"
  },
  {
    id: "U726.1",
    category: "unit",
    description:
      "The HQ panel keeps Team contributions read-only and scopes Personal memory independently.",
    owners: ["HQ-726"],
    harness: "unit"
  },
  {
    id: "S723.1",
    category: "browser",
    description:
      "Sharing entry point, page hierarchy, grouping and truthful statistics.",
    owners: ["HQ-723"],
    harness: "browser"
  },
  {
    id: "S723.2",
    category: "browser",
    description:
      "Recently shared displays real action names, new invitations and its empty state.",
    owners: ["HQ-723"],
    harness: "browser"
  },
  {
    id: "S723.3",
    category: "browser",
    description:
      "Share details show Team-visible counts and owner-local Share Origin links.",
    owners: ["HQ-723"],
    harness: "browser"
  },
  {
    id: "S723.7",
    category: "browser",
    description:
      "Incoming invitations and Project leave use existing reviewed flows.",
    owners: ["HQ-723"],
    harness: "browser"
  },
  {
    id: "S723.8",
    category: "browser",
    description:
      "Six-card expansion and word-start filtering work across both sections.",
    owners: ["HQ-723"],
    harness: "browser"
  },
  {
    id: "S723.9",
    category: "browser",
    description:
      "Sidebar, Settings Teams, visibility Manage and share-sheet entry points open Sharing.",
    owners: ["HQ-723"],
    harness: "browser"
  },
  {
    id: "N723.27",
    category: "browser",
    description:
      "Unavailable backends remain explicit and counts say at least.",
    owners: ["HQ-723"],
    harness: "browser"
  },
  {
    id: "U522.4",
    category: "browser",
    description:
      "Explicit new-chat selection preserves the saved default; running chat handoff carries the draft.",
    owners: ["HQ-522"],
    harness: "browser"
  },
  {
    id: "U522.5",
    category: "browser",
    description:
      "Keep suppresses suggestions until the applicable reset or one hour.",
    owners: ["HQ-522"],
    harness: "browser"
  },
  {
    id: "U522.6",
    category: "browser",
    description:
      "Provider/model-specific warnings distinguish no warning, alternative and warning-only cases.",
    owners: ["HQ-522"],
    harness: "browser"
  },
  {
    id: "N522.20",
    category: "browser",
    description:
      "Suggestions never switch a running Conversation or select another AI without explicit acceptance.",
    owners: ["HQ-522"],
    harness: "browser"
  },
  {
    id: "N522.24",
    category: "browser",
    description:
      "Expired, stale and other-account readings cannot qualify an alternative.",
    owners: ["HQ-522"],
    harness: "browser"
  },
  {
    id: "N522.29",
    category: "browser",
    description:
      "Each provider follows verified-account and positive-evidence eligibility on every applicable reading.",
    owners: ["HQ-522"],
    harness: "browser"
  },
  {
    id: "S724.2",
    category: "positive",
    description:
      "Recently shared offers reviewed removals and invitation cancellation, retaining published knowledge.",
    owners: ["HQ-724"],
    harness: "browser"
  },
  {
    id: "S724.4",
    category: "positive",
    description:
      "Project removal names the affected person, retains contributions, and requires Step-up.",
    owners: ["HQ-724"],
    harness: "browser"
  },
  {
    id: "S724.5",
    category: "positive",
    description:
      "Team removal lists affected Projects and retains contributions under existing Step-up.",
    owners: ["HQ-724"],
    harness: "browser"
  },
  {
    id: "S724.6",
    category: "positive",
    description:
      "Multi-target removal reviews fresh versions sequentially, with truthful per-target outcomes.",
    owners: ["HQ-724"],
    harness: "browser"
  },
  {
    id: "N724.18",
    category: "negative",
    description:
      "Every removal uses its existing review tier and the exact enrolled backend.",
    owners: ["HQ-724"],
    harness: "unit-and-real"
  },
  {
    id: "N724.25",
    category: "negative",
    description:
      "Undo, expired authority and identity loss send no removal; a retry requires new review.",
    owners: ["HQ-724"],
    harness: "unit-and-real"
  },
  {
    id: "N724.30",
    category: "negative",
    description:
      "A committed lost reply replays the same request and authority without a second mutation.",
    owners: ["HQ-724"],
    harness: "unit-and-real"
  },
  {
    id: "N724.32",
    category: "negative",
    description:
      "The second target waits for reconciliation and fresh Project versions, including cancellation and failure.",
    owners: ["HQ-724"],
    harness: "unit-and-real"
  },
  {
    id: "N724.33",
    category: "negative",
    description:
      "Only current Team managers can cancel invitations; Project ownership alone is insufficient.",
    owners: ["HQ-724"],
    harness: "unit-and-real"
  },
  {
    id: "I724.1",
    category: "positive",
    description:
      "Real Native-reviewed invitation cancellation and private origin/read-model attribution.",
    owners: ["HQ-724"],
    harness: "real-api"
  },
  {
    id: "I724.2",
    category: "positive",
    description:
      "Real accepted invitation retains origin, then Step-up removal recovers a committed lost reply.",
    owners: ["HQ-724"],
    harness: "real-api"
  },
  {
    id: "I724.3",
    category: "positive",
    description:
      "Real sequential multi-member removal with one Undo and a forced second-target failure.",
    owners: ["HQ-724"],
    harness: "real-api"
  },
  {
    id: "S725.10.help",
    category: "positive",
    description:
      "The versioned five-point help is shared with the Chief, opens first visit and remembers Hide.",
    owners: ["HQ-725"],
    harness: "unit-and-real"
  },
  {
    id: "S725.10.chat",
    category: "positive",
    description:
      "Help buttons draft the matching question and the Chief can open Sharing from the same help content.",
    owners: ["HQ-725"],
    harness: "unit-and-real"
  },
  {
    id: "S725.11.overview",
    category: "positive",
    description:
      "Authenticated sharing_overview returns the page read model as data, with shared-by-Agent and incoming information.",
    owners: ["HQ-725"],
    harness: "unit-and-real"
  },
  {
    id: "S725.11.person",
    category: "positive",
    description:
      "The agent can narrow live Sharing data to a backend-qualified Project or person.",
    owners: ["HQ-725"],
    harness: "unit-and-real"
  },
  {
    id: "S725.11.removal",
    category: "positive",
    description:
      "Ask first and Full access requests use the same sequential reviewed removal and Undo services.",
    owners: ["HQ-725"],
    harness: "unit-and-real"
  },
  {
    id: "N725.27",
    category: "negative",
    description:
      "The agent retains explicit unavailable Team backends under every filter and never treats them as empty.",
    owners: ["HQ-725"],
    harness: "unit-and-real"
  }
];
