import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { app, BrowserWindow } from "electron";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../..");
const scratchDir = resolve(repoRoot, "scratch");
const pagePath = resolve(scriptDir, "../dist/browser-validation.html");
const expectedFixtureId = "hq-approved-map-fixture-v1";
const expectedFixtureIdentities = [
  "koed-main",
  "investor-deck",
  "koed-mobile",
  "japan-trip",
  "econ-101"
];

const approvedPositiveIds = [
  "S01.1",
  "S01.2",
  "S01.3",
  "S01.4",
  "S02.1",
  "S03.1",
  "I03.1",
  "S04.1",
  "S04.2",
  "S04.3",
  "S04.4",
  "S05.1",
  "S05.2",
  "S06.1",
  "S07.1",
  "S08.1",
  "S09.1",
  "S10.1",
  "S11.1",
  "S12.1",
  "S13.1",
  "I13.1",
  "S14.1",
  "I14.1",
  "S15.1",
  "S15.2",
  "S15.3",
  "S16.1",
  "S17.1",
  "S17.2",
  "S17.3",
  "S17.4",
  "S18.1",
  "S18.2",
  "S18.3",
  "S19.1",
  "S19.2",
  "S19.3",
  "S19.4",
  "S20.1",
  "S20.2",
  "S20.3",
  "I20.3",
  "S20.4",
  "S21.1",
  "U21.1",
  "S22.1",
  "S23.1",
  "I24.1",
  "I25.1",
  "I26.1",
  "I27.1",
  "S28.1",
  "I28.1",
  "S29.1",
  "U29.1",
  "I30.1"
];

const approvedNegativeIds = [
  "N1.S",
  "N1.U",
  "N2.I",
  "N3.S",
  "N3.U",
  "N4.U",
  "N5.I",
  "N6.S",
  "N6.I",
  "N7.S",
  "N7.U",
  "N8.I",
  "N9.U",
  "N10.U",
  "N11.T",
  "N11.I",
  "N12.U",
  "N13.U"
];

const approvedTwoUserIds = [
  "I713.01",
  "I713.02",
  "I713.03",
  "I713.04",
  "I713.05",
  "I713.06",
  "I713.07",
  "I713.08",
  "I713.09",
  "I713.10",
  "I713.11",
  "I713.12",
  "I713.13",
  "I713.14"
];

const browserSkipReason =
  "The scaffold is intentionally empty; this browser case stays skipped until its owning feature ticket implements the mapped clause.";
const unitSkipReason =
  "This ID belongs to its owning unit suite, not the Electron browser harness.";
const integrationSkipReason =
  "This ID requires the real API and Team Backend; simulated IPC is not used as a substitute.";
const teamRepositorySkipReason =
  "This ID belongs to the Team repository test harness, outside this Electron runner.";

const registry = [
  {
    id: "S01.1",
    category: "positive",
    description:
      "Activity is not ticket progress; source/key-item affordance; no 3/5 counter",
    owners: ["HQ-205", "HQ-206", "HQ-207"],
    status: "skip",
    reason: browserSkipReason
  },
  {
    id: "S01.2",
    category: "positive",
    description:
      "Team chip only when the chat column is hidden; all three mapped checks",
    owners: ["HQ-207", "HQ-705"],
    status: "skip",
    reason: browserSkipReason
  },
  {
    id: "S01.3",
    category: "positive",
    description:
      "Shared indicator, need/doing/review/done groups, Project chat placement",
    owners: ["HQ-204", "HQ-207", "HQ-403", "HQ-701", "HQ-705"],
    status: "skip",
    reason: browserSkipReason
  },
  {
    id: "S01.4",
    category: "positive",
    description:
      "Catch-up contains no Team text; deterministic unread-count line appears when appropriate",
    owners: ["HQ-206", "HQ-505", "HQ-705"],
    status: "skip",
    reason: browserSkipReason
  },
  {
    id: "S02.1",
    category: "positive",
    description: "Origin, live log, work brief, back navigation",
    owners: ["HQ-403", "HQ-404"],
    status: "skip",
    reason: browserSkipReason
  },
  {
    id: "S03.1",
    category: "positive",
    description:
      "Privacy note and no colleague-chat link; item shows only safe progress (status, step, PR link), with no chat content",
    owners: ["HQ-404", "HQ-405", "HQ-711"],
    status: "skip",
    reason: browserSkipReason
  },
  {
    id: "I03.1",
    category: "positive",
    description:
      "Integration verifies the real boundary: privacy note, no colleague-chat link, and safe progress without chat content",
    owners: ["HQ-713"],
    status: "skip",
    reason: integrationSkipReason
  },
  {
    id: "S04.1",
    category: "positive",
    description: "Send to agent, Working now, PR, Needs you state",
    owners: ["HQ-404", "HQ-405"],
    status: "skip",
    reason: browserSkipReason
  },
  {
    id: "S04.2",
    category: "positive",
    description:
      "Koed approval names repo, PR, target, head, method, checks; same in Full access",
    owners: ["HQ-405"],
    status: "skip",
    reason: browserSkipReason
  },
  {
    id: "S04.3",
    category: "positive",
    description:
      "Done only after approval and simulated provider `merged` result",
    owners: ["HQ-405"],
    status: "skip",
    reason: browserSkipReason
  },
  {
    id: "S04.4",
    category: "positive",
    description: "Closing ticket reply cites the new memory",
    owners: ["HQ-306", "HQ-405"],
    status: "skip",
    reason: browserSkipReason
  },
  {
    id: "S05.1",
    category: "positive",
    description: "Catch-up does not repeat PRs or finished tickets",
    owners: ["HQ-206", "HQ-405", "HQ-505"],
    status: "skip",
    reason: browserSkipReason
  },
  {
    id: "S05.2",
    category: "positive",
    description:
      "Text proposal, same approval, merged completion; decline leaves In review",
    owners: ["HQ-405", "HQ-408", "HQ-504"],
    status: "skip",
    reason: browserSkipReason
  },
  {
    id: "S06.1",
    category: "positive",
    description:
      "Plan.md creates three tickets through offered, typed, and document paths; second run adds nothing",
    owners: ["HQ-209", "HQ-406", "HQ-504"],
    status: "skip",
    reason: browserSkipReason
  },
  {
    id: "S07.1",
    category: "positive",
    description:
      "Memory number in reply opens next to chat; citation still resolves after reload",
    owners: ["HQ-306"],
    status: "skip",
    reason: browserSkipReason
  },
  {
    id: "S08.1",
    category: "positive",
    description:
      "Colleague PR review without ticket; Needs you updates once approved",
    owners: ["HQ-405"],
    status: "skip",
    reason: browserSkipReason
  },
  {
    id: "S09.1",
    category: "positive",
    description: "Skills and sources are shown; added skill explained",
    owners: ["HQ-205", "HQ-209"],
    status: "skip",
    reason: browserSkipReason
  },
  {
    id: "S10.1",
    category: "positive",
    description: "To-do actions; completion is through `work_item_complete`",
    owners: ["HQ-401", "HQ-403", "HQ-404", "HQ-504"],
    status: "skip",
    reason: browserSkipReason
  },
  {
    id: "S11.1",
    category: "positive",
    description:
      "Context chip, HQ Q&A, Escape/close, fold and visibility controls",
    owners: ["HQ-104", "HQ-207"],
    status: "skip",
    reason: browserSkipReason
  },
  {
    id: "S12.1",
    category: "positive",
    description:
      "Now rows, overflow, cross-Project Needs you, folding, scheduled expansion, row navigation",
    owners: ["HQ-108", "HQ-603"],
    status: "skip",
    reason: browserSkipReason
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
    status: "skip",
    reason: browserSkipReason
  },
  {
    id: "I13.1",
    category: "positive",
    description:
      "Integration verifies the real join state after summary-sharing disclosure and welcome without Team text",
    owners: ["HQ-713"],
    status: "skip",
    reason: integrationSkipReason
  },
  {
    id: "S14.1",
    category: "positive",
    description:
      "Email invitation, one access level, join, explanation of what invitees never receive, text share with confirmation, and share-sheet contents",
    owners: ["HQ-504", "HQ-701", "HQ-703"],
    status: "skip",
    reason: browserSkipReason
  },
  {
    id: "I14.1",
    category: "positive",
    description:
      "Integration verifies invitation, join, and share effects through the real API and Team Backend",
    owners: ["HQ-713"],
    status: "skip",
    reason: integrationSkipReason
  },
  {
    id: "S15.1",
    category: "positive",
    description:
      "Sidebar grouping and confirmation before sharing by moving a chat",
    owners: ["HQ-103", "HQ-107"],
    status: "skip",
    reason: browserSkipReason
  },
  {
    id: "S15.2",
    category: "positive",
    description: "Summary-sharing wording; no Conversation Source Access",
    owners: ["HQ-702"],
    status: "skip",
    reason: browserSkipReason
  },
  {
    id: "S15.3",
    category: "positive",
    description: "Share toast, Team visibility label, group folding",
    owners: ["HQ-103", "HQ-701", "HQ-702"],
    status: "skip",
    reason: browserSkipReason
  },
  {
    id: "S16.1",
    category: "positive",
    description:
      "Loose chats in Just me with overflow, workspace sheet, and “who's in” by text",
    owners: ["HQ-103", "HQ-504", "HQ-701"],
    status: "skip",
    reason: browserSkipReason
  },
  {
    id: "S17.1",
    category: "positive",
    description: "Just me/Team tabs, unread indicator, Team visibility label",
    owners: ["HQ-103", "HQ-705"],
    status: "skip",
    reason: browserSkipReason
  },
  {
    id: "S17.2",
    category: "positive",
    description: "Human-only Team message disclosure; no saved-decision mark",
    owners: ["HQ-705"],
    status: "skip",
    reason: browserSkipReason
  },
  {
    id: "S17.3",
    category: "positive",
    description: "`@Rook` offers people from the mention picker only",
    owners: ["HQ-705", "HQ-706"],
    status: "skip",
    reason: browserSkipReason
  },
  {
    id: "S17.4",
    category: "positive",
    description: "Private chat remains separate",
    owners: ["HQ-103", "HQ-702", "HQ-705"],
    status: "skip",
    reason: browserSkipReason
  },
  {
    id: "S18.1",
    category: "positive",
    description: "Memory grouping, replacement, Forget this control",
    owners: ["HQ-303", "HQ-304", "HQ-307"],
    status: "skip",
    reason: browserSkipReason
  },
  {
    id: "S18.2",
    category: "positive",
    description:
      "Me is not shared; legacy unscoped items do not appear under Me",
    owners: ["HQ-301", "HQ-302", "HQ-303", "HQ-304"],
    status: "skip",
    reason: browserSkipReason
  },
  {
    id: "S18.3",
    category: "positive",
    description:
      "Text “forget that” targets the User's own latest cited assertion; Now is home",
    owners: ["HQ-108", "HQ-306", "HQ-307", "HQ-504"],
    status: "skip",
    reason: browserSkipReason
  },
  {
    id: "S19.1",
    category: "positive",
    description: "HQ and Needs you rows show memory chips",
    owners: ["HQ-308"],
    status: "skip",
    reason: browserSkipReason
  },
  {
    id: "S19.2",
    category: "positive",
    description:
      "Loose chat citation is marked Just me; sidebar scroll remains stable",
    owners: ["HQ-103", "HQ-105", "HQ-306"],
    status: "skip",
    reason: browserSkipReason
  },
  {
    id: "S19.3",
    category: "positive",
    description: "Deleting koed-mobile preserves resolvable memory chips",
    owners: ["HQ-202", "HQ-208", "HQ-306", "HQ-308"],
    status: "skip",
    reason: browserSkipReason
  },
  {
    id: "S19.4",
    category: "positive",
    description:
      "“Leave koed-main” identifies the User as owner and follows the explicit delete path",
    owners: ["HQ-208", "HQ-704"],
    status: "skip",
    reason: browserSkipReason
  },
  {
    id: "S20.1",
    category: "positive",
    description: "Indentation and visibility line before first message",
    owners: ["HQ-103", "HQ-105", "HQ-711"],
    status: "skip",
    reason: browserSkipReason
  },
  {
    id: "S20.2",
    category: "positive",
    description:
      "Team-leave confirmation says a new invite is needed to return",
    owners: ["HQ-704"],
    status: "skip",
    reason: browserSkipReason
  },
  {
    id: "S20.3",
    category: "positive",
    description:
      "Workspace removal with Personal Project and to-dos retained after copy-back",
    owners: ["HQ-704", "HQ-712"],
    status: "skip",
    reason: browserSkipReason
  },
  {
    id: "I20.3",
    category: "positive",
    description:
      "Integration verifies copy-back and backend effects through the real API and Team Backend",
    owners: ["HQ-713"],
    status: "skip",
    reason: integrationSkipReason
  },
  {
    id: "S20.4",
    category: "positive",
    description: "No Undo button on leave toast",
    owners: ["HQ-704"],
    status: "skip",
    reason: browserSkipReason
  },
  {
    id: "S21.1",
    category: "positive",
    description: "Econ 101 deadlines/order/menu/Now states",
    owners: ["HQ-209", "HQ-402", "HQ-407"],
    status: "skip",
    reason: browserSkipReason
  },
  {
    id: "U21.1",
    category: "positive",
    description:
      "The same `due_on` reads “Due tomorrow” for a viewer in another time zone on that calendar day",
    owners: ["HQ-402 unit suite"],
    status: "skip",
    reason: unitSkipReason
  },
  {
    id: "S22.1",
    category: "positive",
    description:
      "Shared deck interaction; Again learning is saved to that person's Me memory",
    owners: ["HQ-504", "HQ-802", "HQ-803"],
    status: "skip",
    reason: browserSkipReason
  },
  {
    id: "S23.1",
    category: "positive",
    description: "Quote chip, Escape, one-line quote, jump, no threads",
    owners: ["HQ-705", "HQ-707"],
    status: "skip",
    reason: browserSkipReason
  },
  {
    id: "I24.1",
    category: "positive",
    description:
      "Chat/source/Project deletion and leave freeze published material for recall, exclude later messages/revisions, keep a leaver's material inspectable by remaining members, and do not resume after restore",
    owners: ["HQ-715", "HQ-713 integration suite"],
    status: "skip",
    reason: integrationSkipReason
  },
  {
    id: "I25.1",
    category: "positive",
    description:
      "Leave copy-back retry/interruption and last-owner refusal before side effects",
    owners: ["HQ-704", "HQ-712", "HQ-713 integration suite"],
    status: "skip",
    reason: integrationSkipReason
  },
  {
    id: "I26.1",
    category: "positive",
    description: "Shared cards and per-person progress/Again-to-Me",
    owners: ["HQ-801", "HQ-803", "HQ-713 integration suite"],
    status: "skip",
    reason: integrationSkipReason
  },
  {
    id: "I27.1",
    category: "positive",
    description: "Curated exact provenance/scope and invalidation",
    owners: ["HQ-301", "HQ-302", "HQ-702", "HQ-713 integration suite"],
    status: "skip",
    reason: integrationSkipReason
  },
  {
    id: "S28.1",
    category: "positive",
    description: "Multiple citations reload from aliases",
    owners: ["HQ-306", "HQ-714"],
    status: "skip",
    reason: browserSkipReason
  },
  {
    id: "I28.1",
    category: "positive",
    description: "Team details reauthorize after revocation",
    owners: ["HQ-306", "HQ-714", "HQ-713 integration suite"],
    status: "skip",
    reason: integrationSkipReason
  },
  {
    id: "S29.1",
    category: "positive",
    description:
      "Changed checks conflict; unknown dispatch is recovered read-only without retry",
    owners: ["HQ-405", "HQ-408"],
    status: "skip",
    reason: browserSkipReason
  },
  {
    id: "U29.1",
    category: "positive",
    description:
      "Changed checks conflict; unknown dispatch is recovered read-only without retry",
    owners: ["HQ-408 unit suite"],
    status: "skip",
    reason: unitSkipReason
  },
  {
    id: "I30.1",
    category: "positive",
    description:
      "Combined selectors: linked Project + Me only; Team global Workspace search with no personal project id",
    owners: ["HQ-714", "HQ-713 integration suite"],
    status: "skip",
    reason: integrationSkipReason
  },
  {
    id: "N1.S",
    category: "negative",
    description:
      "Team message sentinel never reaches catch-up, memory proposals, or agent turns",
    owners: ["HQ-505", "HQ-705"],
    status: "skip",
    reason: browserSkipReason
  },
  {
    id: "N1.U",
    category: "negative",
    description:
      "Team message sentinel never reaches memory proposals or agent turns",
    owners: ["D2 boundary unit suite"],
    status: "skip",
    reason: unitSkipReason
  },
  {
    id: "N2.I",
    category: "negative",
    description:
      "Project Share Policy never creates Conversation Source Access",
    owners: ["HQ-713 integration suite"],
    status: "skip",
    reason: integrationSkipReason
  },
  {
    id: "N3.S",
    category: "negative",
    description:
      "Native approval in Full access, changed-state reapproval, repository method policy, duplicate and unknown-dispatch behavior",
    owners: ["HQ-405", "HQ-408"],
    status: "skip",
    reason: browserSkipReason
  },
  {
    id: "N3.U",
    category: "negative",
    description:
      "Native approval in Full access, changed-state reapproval, repository method policy, duplicate and unknown-dispatch behavior",
    owners: ["HQ-405/HQ-408 unit suites"],
    status: "skip",
    reason: unitSkipReason
  },
  {
    id: "N4.U",
    category: "negative",
    description: "AI Client process gets no source-control credentials",
    owners: ["HQ-408 unit suite"],
    status: "skip",
    reason: unitSkipReason
  },
  {
    id: "N5.I",
    category: "negative",
    description: "Owner cannot grant another member's Conversation",
    owners: ["HQ-713 integration suite"],
    status: "skip",
    reason: integrationSkipReason
  },
  {
    id: "N6.S",
    category: "negative",
    description:
      "No Undo for leave; restore after shared-Project deletion does not recreate access",
    owners: ["HQ-704"],
    status: "skip",
    reason: browserSkipReason
  },
  {
    id: "N6.I",
    category: "negative",
    description:
      "Restore after shared-Project deletion does not recreate access",
    owners: ["HQ-713 integration suite"],
    status: "skip",
    reason: integrationSkipReason
  },
  {
    id: "N7.S",
    category: "negative",
    description: "Chat deletion retains recall; explicit forget removes it",
    owners: ["HQ-202", "HQ-208"],
    status: "skip",
    reason: browserSkipReason
  },
  {
    id: "N7.U",
    category: "negative",
    description: "Chat deletion retains recall; explicit forget removes it",
    owners: ["HQ-202/HQ-208 unit suites"],
    status: "skip",
    reason: unitSkipReason
  },
  {
    id: "N8.I",
    category: "negative",
    description:
      "Curated positive control plus Me/unscoped/mixed-session/non-Conversation exclusions",
    owners: ["HQ-713 integration suite"],
    status: "skip",
    reason: integrationSkipReason
  },
  {
    id: "N9.U",
    category: "negative",
    description: "Closing without merge never marks a Work Item done",
    owners: ["HQ-405 unit suite"],
    status: "skip",
    reason: unitSkipReason
  },
  {
    id: "N10.U",
    category: "negative",
    description: "Two devices never execute the same scheduled lease",
    owners: ["HQ-602 unit suite"],
    status: "skip",
    reason: unitSkipReason
  },
  {
    id: "N11.T",
    category: "negative",
    description:
      "Freeze/publication race, another grant still advances, revocation/suppression/expiry still deny",
    owners: ["HQ-715 Team repository suite"],
    status: "skip",
    reason: teamRepositorySkipReason
  },
  {
    id: "N11.I",
    category: "negative",
    description:
      "Freeze/publication race, another grant still advances, revocation/suppression/expiry still deny",
    owners: ["HQ-713 integration suite"],
    status: "skip",
    reason: integrationSkipReason
  },
  {
    id: "N12.U",
    category: "negative",
    description:
      "Ownership checked before forget mutation; explicit/latest teammate citation never falls back to older owned assertion; ambiguous reference asks",
    owners: ["HQ-306", "HQ-307", "HQ-504 unit suites"],
    status: "skip",
    reason: unitSkipReason
  },
  {
    id: "N13.U",
    category: "negative",
    description:
      "Project Source trash is independent of Note revision forget; no source `personal_deleted_at`; retries do not duplicate revisions/events",
    owners: ["HQ-209 unit suite"],
    status: "skip",
    reason: unitSkipReason
  },
  {
    id: "I713.01",
    category: "two-user",
    description:
      "Alice shares Project “landing” with Bob; the share sheet lists docs, to-dos, and summaries",
    owners: ["HQ-713 real API/Team Backend suite"],
    status: "skip",
    reason: integrationSkipReason
  },
  {
    id: "I713.02",
    category: "two-user",
    description:
      "Bob accepts; the join card states summary sharing; his sidebar shows “landing” under Shared and his HQ remains private",
    owners: ["HQ-713 real API/Team Backend suite"],
    status: "skip",
    reason: integrationSkipReason
  },
  {
    id: "I713.03",
    category: "two-user",
    description:
      "Alice's Project chat is shared as a summary; Bob's recall finds it with a Team citation and no transcript is reachable",
    owners: ["HQ-713 real API/Team Backend suite"],
    status: "skip",
    reason: integrationSkipReason
  },
  {
    id: "I713.04",
    category: "two-user",
    description:
      "Bob adds a to-do and Alice sees it live; conflicting title edits produce one conflict notice without data loss",
    owners: ["HQ-713 real API/Team Backend suite"],
    status: "skip",
    reason: integrationSkipReason
  },
  {
    id: "I713.05",
    category: "two-user",
    description:
      "Bob sends a to-do to his agent; Alice sees status and step only",
    owners: ["HQ-713 real API/Team Backend suite"],
    status: "skip",
    reason: integrationSkipReason
  },
  {
    id: "I713.06",
    category: "two-user",
    description: "Alice makes a chat private; its summary leaves Bob's recall",
    owners: ["HQ-713 real API/Team Backend suite"],
    status: "skip",
    reason: integrationSkipReason
  },
  {
    id: "I713.07",
    category: "two-user",
    description:
      "With Bob offline and the backend blocked, the Project is read-only and shows the offline notice",
    owners: ["HQ-713 real API/Team Backend suite"],
    status: "skip",
    reason: integrationSkipReason
  },
  {
    id: "I713.08",
    category: "two-user",
    description:
      "Alice deletes the Project; it disappears for Bob, Bob's recall retains already-shared material, his own chats move to Just me, and their grants freeze at the last published closure so later messages/revisions are excluded",
    owners: ["HQ-713 real API/Team Backend suite"],
    status: "skip",
    reason: integrationSkipReason
  },
  {
    id: "I713.09",
    category: "two-user",
    description:
      "Alice restores the Project; records/thread return, Bob's chats stay where they are, and frozen grants do not resume",
    owners: ["HQ-713 real API/Team Backend suite"],
    status: "skip",
    reason: integrationSkipReason
  },
  {
    id: "I713.10",
    category: "two-user",
    description:
      "A second share run interrupted after step 2 of ADR 0062's copy resumes without duplicates",
    owners: ["HQ-713 real API/Team Backend suite"],
    status: "skip",
    reason: integrationSkipReason
  },
  {
    id: "I713.11",
    category: "two-user",
    description:
      "Bob leaves after sharing a Conversation; Alice can inspect Bob's published frozen material but not later messages, Bob loses access to Alice's Team memory, and leaving one Project alone preserves his global Team membership",
    owners: ["HQ-713 real API/Team Backend suite"],
    status: "skip",
    reason: integrationSkipReason
  },
  {
    id: "I713.12",
    category: "two-user",
    description:
      "With Curated enabled, Alice sees Bob's Project assertion only when all active direct sources are within the exact granted session; she sees its summary but not Bob's Me/unscoped/mixed-session assertions. Scope change invalidates the Team representation before commit. HQ-714 returns linked Project context plus Me without other Projects; Team inputs use `search_domain=global`, trusted Workspace/backend IDs, and no personal `project_id`.",
    owners: ["HQ-713 real API/Team Backend suite"],
    status: "skip",
    reason: integrationSkipReason
  },
  {
    id: "I713.13",
    category: "two-user",
    description:
      "Alice and Bob study one shared deck; cards are common while progress and Again-to-Me learning differ by member",
    owners: ["HQ-713 real API/Team Backend suite"],
    status: "skip",
    reason: integrationSkipReason
  },
  {
    id: "I713.14",
    category: "two-user",
    description:
      "Bob's owned-Project leave copy-back is interrupted and resumed idempotently; last-owner leave is refused before copy-back, and after ownership transfer successful copy plus version/authority revalidation precede removal",
    owners: ["HQ-713 real API/Team Backend suite"],
    status: "skip",
    reason: integrationSkipReason
  }
];

const validateRegistry = () => {
  const expectedIds = [
    ...approvedPositiveIds,
    ...approvedNegativeIds,
    ...approvedTwoUserIds
  ];
  const registeredIds = registry.map(({ id }) => id);
  assert.equal(approvedPositiveIds.length, 57);
  assert.equal(approvedNegativeIds.length, 18);
  assert.equal(approvedTwoUserIds.length, 14);
  assert.equal(new Set(expectedIds).size, expectedIds.length);
  assert.equal(new Set(registeredIds).size, registeredIds.length);
  assert.equal(registry.length, 89);
  assert.deepEqual(
    [...registeredIds].sort(),
    [...expectedIds].sort(),
    "The case registry must exactly cover the separate approved ID lists."
  );
  for (const entry of registry) {
    assert.ok(entry.description, `${entry.id} needs its approved description`);
    assert.ok(entry.owners.length > 0, `${entry.id} needs a visible owner`);
    assert.ok(entry.reason, `${entry.id} needs a visible skip reason`);
    assert.equal(
      entry.status,
      "skip",
      `${entry.id} must remain visibly skipped`
    );
  }
  for (const [category, ids] of [
    ["positive", approvedPositiveIds],
    ["negative", approvedNegativeIds],
    ["two-user", approvedTwoUserIds]
  ]) {
    for (const id of ids) {
      assert.equal(
        registry.find((entry) => entry.id === id)?.category,
        category,
        `${id} must remain in its approved registry category.`
      );
    }
  }
};

const runAssertion = async (name, assertion) => {
  try {
    await assertion();
    process.stdout.write(`PASS ${name}\n`);
    return true;
  } catch (error) {
    process.stderr.write(
      `FAIL ${name}: ${error instanceof Error ? error.stack : String(error)}\n`
    );
    throw error;
  }
};

const reportSkippedCases = () => {
  for (const entry of registry) {
    const description = entry.description.trimEnd();
    const separator = /[.!?]$/u.test(description) ? " " : ". ";
    process.stdout.write(
      `SKIP ${entry.id} [${entry.owners.join(", ")}]: ${description}${separator}${entry.reason}\n`
    );
  }
};

const waitForHqFixture = async (window) => {
  let last = null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    last = await window.webContents.executeJavaScript(`(() => {
      const shell = document.querySelector('[data-hq-shell]');
      const fixture = window.__koedHqFixture;
      return {
        ready: document.documentElement.dataset.browserValidationReady === 'true',
        fixtureReady: document.documentElement.dataset.hqFixtureReady === 'true',
        shellCount: document.querySelectorAll('[data-hq-shell]').length,
        shellTag: shell?.tagName ?? null,
        shellChildren: shell?.childElementCount ?? -1,
        fixtureId: fixture?.fixtureId ?? null,
        hasSummary: typeof fixture?.summary === 'function',
        hasReset: typeof fixture?.reset === 'function',
        hasSnapshot: typeof fixture?.snapshot === 'function'
      };
    })()`);
    if (
      last.ready &&
      last.fixtureReady &&
      last.shellCount === 1 &&
      last.fixtureId === expectedFixtureId &&
      last.hasSummary &&
      last.hasReset &&
      last.hasSnapshot
    ) {
      return last;
    }
    await delay(25);
  }
  throw new Error(`HQ browser fixture did not mount: ${JSON.stringify(last)}`);
};

const runValidation = async () => {
  validateRegistry();
  reportSkippedCases();
  const userDataPath = process.env.KOED_HQ_USER_DATA_DIR;
  assert.ok(
    userDataPath,
    "Use run-hq-validation.mjs to create a test profile."
  );
  assert.equal(
    dirname(resolve(userDataPath)),
    scratchDir,
    "The HQ browser profile must be isolated under the repository scratch directory."
  );
  app.setPath("userData", userDataPath);
  let window;
  let debuggerClient;
  const rendererErrors = [];
  const rendererExceptions = [];

  try {
    await app.whenReady();
    window = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800
    });
    window.webContents.on("console-message", (_event, details) => {
      if (details.level === "error") rendererErrors.push(details.message);
    });
    window.webContents.on("render-process-gone", (_event, details) => {
      rendererErrors.push(`Renderer process exited: ${details.reason}`);
    });
    debuggerClient = window.webContents.debugger;
    debuggerClient.on("message", (_event, method, params) => {
      if (method === "Runtime.exceptionThrown") {
        rendererExceptions.push(params.exceptionDetails?.text ?? method);
      }
    });

    await window.loadFile(pagePath, { query: { view: "hq" } });
    const mounted = await waitForHqFixture(window);
    debuggerClient.attach("1.3");
    await debuggerClient.sendCommand("Runtime.enable");
    await debuggerClient.sendCommand("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false
    });
    await delay(50);
    const fixture = await window.webContents.executeJavaScript(`(() => {
      const handle = window.__koedHqFixture;
      const snapshot = handle.snapshot();
      const seedSnapshot = handle.snapshot();
      handle.changeProjectName('koed-main', 'scaffold-smoke-mutated');
      const mutatedSnapshot = handle.snapshot();
      const recorded = handle.summary();
      handle.reset();
      const after = handle.summary();
      const resetSnapshot = handle.snapshot();
      return {
        ...after,
        snapshot,
        resetActuallyChangedSeed: seedSnapshot.projects[0].name === 'koed-main' && mutatedSnapshot.projects[0].name === 'scaffold-smoke-mutated',
        resetRestoredSeed: JSON.stringify(seedSnapshot) === JSON.stringify(resetSnapshot),
        resetClearedMutation: recorded.operations.mutations.length === 1 && after.operations.mutations.length === 0,
        markerText: document.querySelector('[data-hq-shell]')?.textContent?.trim() ?? null,
        rootChildCount: document.querySelector('#root')?.childElementCount ?? -1,
        browserReady: document.documentElement.dataset.browserValidationReady === 'true'
      };
    })()`);

    await runAssertion("Scaffold/fixture smoke", async () => {
      assert.equal(mounted.shellCount, 1);
      assert.equal(mounted.shellTag, "MAIN");
      assert.equal(mounted.shellChildren, 0);
      assert.equal(fixture.fixtureId, expectedFixtureId);
      assert.deepEqual(fixture.identities, expectedFixtureIdentities);
      assert.deepEqual(
        fixture.snapshot.projects.map(({ id }) => id),
        expectedFixtureIdentities
      );
      assert.equal(fixture.fixedAt, "2026-10-19T09:00:00.000Z");
      assert.equal(fixture.projects, 5);
      assert.equal(fixture.conversations, 5);
      assert.equal(fixture.privateHqConversations, 6);
      assert.equal(fixture.capturedSessions, 2);
      assert.equal(fixture.runtimeItems, 3);
      assert.equal(fixture.memories, 2);
      assert.equal(fixture.projectSources, 3);
      assert.equal(fixture.workItems, 2);
      assert.equal(fixture.flashcardDecks, 1);
      assert.deepEqual(
        fixture.snapshot.projects.map(({ id, name, people }) => ({
          id,
          name,
          people
        })),
        [
          { id: "koed-main", name: "koed-main", people: ["Mark"] },
          { id: "investor-deck", name: "Investor deck", people: ["Sam"] },
          { id: "koed-mobile", name: "koed-mobile", people: [] },
          { id: "japan-trip", name: "Japan trip", people: [] },
          { id: "econ-101", name: "Econ 101", people: ["Lena", "Omar"] }
        ]
      );
      assert.ok(
        fixture.snapshot.conversations.some(
          ({ visibility }) => visibility === "shared-summary"
        )
      );
      assert.ok(
        fixture.snapshot.conversations.some(
          ({ visibility }) => visibility === "personal"
        )
      );
      assert.ok(
        fixture.snapshot.privateHqConversations.every(({ owner }) => owner)
      );
      assert.ok(
        fixture.snapshot.capturedSessions.every(
          ({ source }) => source === "captured-session"
        )
      );
      assert.ok(
        fixture.snapshot.projectSources.every(
          ({ origin }) => origin === "project-source"
        )
      );
      assert.deepEqual(fixture.snapshot.teamMessages, [
        {
          id: "team-message-human-sentinel",
          projectId: "koed-main",
          author: "Mark",
          authorKind: "human",
          unreadFor: ["You"],
          text: "The launch review is now scheduled for Thursday."
        }
      ]);
      assert.equal(fixture.teamMessages, 1);
      assert.deepEqual(fixture.teamMessageAuthors, ["human"]);
      assert.equal(fixture.teamCatchUpMessageIds, 0);
      assert.equal(fixture.teamAgentTurnInputs, 0);
      assert.equal(fixture.teamMemoryProposalInputs, 0);
      assert.equal(fixture.teamMessageSourceIds, 0);
      assert.equal(fixture.forbiddenTeamContentPresent, false);
      assert.equal(fixture.resetActuallyChangedSeed, true);
      assert.equal(fixture.resetRestoredSeed, true);
      assert.equal(fixture.resetClearedMutation, true);
      assert.equal(fixture.markerText, "");
      assert.equal(fixture.rootChildCount, 1);
      assert.equal(fixture.browserReady, true);
      assert.deepEqual(rendererErrors, []);
      assert.deepEqual(rendererExceptions, []);
    });

    process.stdout.write(
      `HQ acceptance harness: 1 active scaffold/fixture smoke passed; ${approvedPositiveIds.length} positive, ${approvedNegativeIds.length} negative, and ${approvedTwoUserIds.length} two-user IDs remain explicit SKIP entries in this browser report. Out-of-harness cases still require results from their actual owning suites.\n`
    );
  } finally {
    if (debuggerClient?.isAttached()) debuggerClient.detach();
    if (window && !window.isDestroyed()) window.destroy();
    app.quit();
  }
};

runValidation().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`
  );
  app.exit(1);
});
