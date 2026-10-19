import { validateHqSettings } from "./validate-hq-settings.mjs";
import { validateHqNow } from "./validate-hq-now.mjs";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { app, BrowserWindow, nativeImage } from "electron";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../..");
const scratchDir = resolve(repoRoot, "scratch");
const screenshotDir = resolve(scratchDir, "hq-103", "screenshots");
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
  "This acceptance-map clause remains SKIP until every listed owning ticket is implemented and validated.";
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
        hasProjectNavigation: Boolean(shell?.querySelector('aside[aria-label="Project navigation"]')),
        hasProjectLoadError: Boolean(shell?.querySelector('[data-hq-project-load-error]')),
        hasProjectRetry: Boolean(shell?.querySelector('[data-hq-project-retry]')),
        hasWorkspace: Boolean(shell?.querySelector('main[aria-label="HQ workspace"]')),
        hasContext: Boolean(shell?.querySelector('[data-hq-context][role="complementary"]')),
        hasSidebarHandle: Boolean(shell?.querySelector('[data-hq-sidebar-handle][role="separator"]')),
        hasContextHandle: Boolean(shell?.querySelector('[data-hq-context-handle][role="separator"]')),
        sidebarProjectCount: shell?.querySelectorAll('[data-hq-project-link]').length ?? 0,
        sidebarWidth: Number(shell?.querySelector('[data-hq-sidebar-handle]')?.getAttribute('aria-valuenow') ?? NaN),
        contextWidth: Number(shell?.querySelector('[data-hq-context-handle]')?.getAttribute('aria-valuenow') ?? NaN),
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
      (last.sidebarProjectCount === 4 || last.hasProjectLoadError) &&
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
        rendererExceptions.push(
          params.exceptionDetails?.exception?.description ??
            params.exceptionDetails?.text ??
            method
        );
      }
    });

    await window.loadURL("about:blank");
    debuggerClient.attach("1.3");
    await debuggerClient.sendCommand("Runtime.enable");
    await window.loadFile(pagePath, {
      query: { projectsFailure: "once", view: "hq" }
    });
    let mounted;
    try {
      mounted = await waitForHqFixture(window);
    } catch (cause) {
      throw new Error(
        `${cause instanceof Error ? cause.message : String(cause)}\nRenderer errors: ${JSON.stringify(rendererErrors)}\nRenderer exceptions: ${JSON.stringify(rendererExceptions)}`,
        { cause }
      );
    }
    await debuggerClient.sendCommand("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false
    });
    await delay(50);

    const captureScreenshot = async (name, selector) => {
      const clip = selector
        ? await window.webContents.executeJavaScript(
            `(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)}; })()`
          )
        : undefined;
      const { data } = await debuggerClient.sendCommand(
        "Page.captureScreenshot",
        {
          format: "png",
          captureBeyondViewport: false
        }
      );
      await mkdir(screenshotDir, { recursive: true });
      const viewport = Buffer.from(data, "base64");
      // Crop the captured viewport pixels so narrow device emulation cannot
      // apply a second scale factor to an element-only screenshot.
      const output = clip
        ? nativeImage.createFromBuffer(viewport).crop(clip).toPNG()
        : viewport;
      await writeFile(resolve(screenshotDir, name), output);
    };

    await runAssertion(
      "HQ103 project-load errors offer a working retry",
      async () => {
        const failed = await window.webContents.executeJavaScript(`(() => ({
          error: Boolean(document.querySelector('[data-hq-project-load-error]')),
          retry: Boolean(document.querySelector('[data-hq-project-retry]')),
          projects: document.querySelectorAll('[data-hq-project-link]').length,
          emptyState: document.body.textContent.includes('No Projects or Chats yet')
        }))()`);
        assert.deepEqual(failed, {
          error: true,
          retry: true,
          projects: 0,
          emptyState: false
        });
        await window.webContents.executeJavaScript(
          "document.querySelector('[data-hq-project-retry]')?.click()"
        );
        let recovered = null;
        for (let attempt = 0; attempt < 40; attempt += 1) {
          recovered = await window.webContents.executeJavaScript(`(() => ({
            error: Boolean(document.querySelector('[data-hq-project-load-error]')),
            projects: document.querySelectorAll('[data-hq-project-link]').length
          }))()`);
          if (recovered.projects === 4 && !recovered.error) break;
          await delay(25);
        }
        assert.deepEqual(recovered, { error: false, projects: 4 });
      }
    );
    await runAssertion(
      "HQ108 Now home, existing Needs you sources, route and folds",
      async () => {
        await validateHqNow(window, pagePath, captureScreenshot, delay);
      }
    );
    // Context is a Project capability; exercise HQ102 layout in a real
    // Project route rather than keeping its panel on Home or Conversations.
    await window.webContents.executeJavaScript(
      `document.querySelector('[data-hq-project-link="hq103-koed"]')?.click()`
    );
    for (let attempt = 0; attempt < 40; attempt += 1) {
      mounted = await waitForHqFixture(window);
      if (mounted.hasContext && mounted.hasContextHandle) break;
      await delay(25);
    }
    assert.equal(mounted.hasContext, true);
    assert.equal(mounted.hasContextHandle, true);

    await window.webContents.executeJavaScript(`(() => {
      document.documentElement.classList.remove('dark');
      document.documentElement.classList.add('light');
      document.documentElement.dataset.theme = 'light';
    })()`);
    await captureScreenshot("hq103-sidebar-light.png");
    await captureScreenshot("hq103-v50-sidebar-light-crop.png", ".hq-sidebar");
    await captureScreenshot(
      "hq103-v50-header-light-crop.png",
      ".hq-main__header"
    );
    const geometry = await window.webContents.executeJavaScript(`(() => {
      const read = (selector) => { const el=document.querySelector(selector); const r=el.getBoundingClientRect(); const c=getComputedStyle(el);return { x:r.x,y:r.y,width:r.width,height:r.height,font:c.fontSize,padding:c.padding,radius:c.borderRadius,background:c.backgroundColor,color:c.color,borderBottom:c.borderBottomWidth }; };
      return { viewport:{width:innerWidth,height:innerHeight},sidebar:read('.hq-sidebar'),header:read('.hq-main__header'),brand:read('.hq-brand'),row:read('[data-hq-project-link]'),group:read('[data-hq-sidebar-group]'),more:read('.hq-sidebar__more'),handle:read('[data-hq-sidebar-handle]'),permanentProjectChevron:!!document.querySelector('[data-hq-project-chevron]'),genericChatBubble:!!document.querySelector('[data-hq-chat-icon]') };
    })()`);
    assert.equal(geometry.sidebar.width, 268);
    assert.equal(geometry.header.height, 56);
    assert.equal(geometry.header.borderBottom, "0px");
    assert.equal(geometry.row.font, "14px");
    assert.equal(geometry.row.padding, "7px 9px");
    assert.equal(geometry.row.radius, "10px");
    assert.ok(Math.abs(geometry.row.height - 36.4) < 1);
    assert.equal(geometry.group.font, "11.5px");
    assert.equal(geometry.more.font, "12.5px");
    assert.equal(geometry.handle.background, "rgba(0, 0, 0, 0)");
    assert.equal(geometry.permanentProjectChevron, false);
    assert.equal(geometry.genericChatBubble, false);
    await mkdir(screenshotDir, { recursive: true });
    await writeFile(
      resolve(screenshotDir, "hq103-v50-geometry.json"),
      JSON.stringify(geometry, null, 2) + "\n"
    );
    await window.webContents.executeJavaScript(`(() => {
      document.documentElement.classList.remove('light');
      document.documentElement.classList.add('dark');
      document.documentElement.dataset.theme = 'dark';
    })()`);
    await captureScreenshot("hq103-sidebar-dark.png");
    await captureScreenshot("hq103-v50-sidebar-dark-crop.png", ".hq-sidebar");
    await captureScreenshot(
      "hq103-v50-header-dark-crop.png",
      ".hq-main__header"
    );
    const scrollBeforeCompact = await window.webContents.executeJavaScript(
      `(() => { const scroll=document.querySelector('[data-hq-sidebar-scroll]'); scroll.scrollTop=Math.min(120,scroll.scrollHeight-scroll.clientHeight);scroll.dispatchEvent(new Event('scroll'));return scroll.scrollTop; })()`
    );
    assert.ok(scrollBeforeCompact > 0);
    await window.webContents.executeJavaScript(
      "document.querySelector('.hq-desktop-navigation-trigger')?.click()"
    );
    await delay(30);
    const compact = await window.webContents.executeJavaScript(
      `(() => ({ width:document.querySelector('.hq-sidebar').getBoundingClientRect().width, expandedWidth:document.querySelector('[data-hq-sidebar-handle]').getAttribute('aria-valuenow'), headingHidden:getComputedStyle(document.querySelector('.hq-brand-name')).display }))()`
    );
    assert.equal(compact.width, 64);
    assert.equal(compact.headingHidden, "none");
    await captureScreenshot("hq103-v50-compact-dark-crop.png", ".hq-sidebar");
    await window.webContents.executeJavaScript(
      "document.querySelector('.hq-desktop-navigation-trigger')?.click()"
    );
    await delay(30);
    assert.equal(
      await window.webContents.executeJavaScript(
        "document.querySelector('.hq-sidebar').getBoundingClientRect().width"
      ),
      268
    );
    assert.equal(
      await window.webContents.executeJavaScript(
        "document.querySelector('[data-hq-sidebar-scroll]').scrollTop"
      ),
      scrollBeforeCompact
    );
    await window.webContents.executeJavaScript(
      "document.querySelector('[data-hq-sidebar-scroll]').scrollTop=0; document.querySelector('[data-hq-sidebar-scroll]').dispatchEvent(new Event('scroll'))"
    );

    await debuggerClient.sendCommand("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 640,
      deviceScaleFactor: 1,
      mobile: false
    });
    await delay(60);
    await delay(60);
    await runAssertion(
      "HQ103 sidebar subchecks (compound acceptance-map IDs remain SKIP)",
      async () => {
        const initialSidebar = await window.webContents
          .executeJavaScript(`(() => {
          const projectLinks = [...document.querySelectorAll('[data-hq-project-link]')];
          const chatRows = [...document.querySelectorAll('[data-hq-chat-title]')];
          const more = [...document.querySelectorAll('.hq-sidebar__more')].map((item) => item.textContent?.trim());
          const scroll = document.querySelector('[data-hq-sidebar-scroll]');
          const groupIcon = document.querySelector('[data-hq-group-icon]')?.getBoundingClientRect();
          const projectIcon = document.querySelector('[data-hq-project-icon]')?.getBoundingClientRect();
          const chatIcon = document.querySelector('[data-hq-chat-icon]')?.getBoundingClientRect();
          const projectName = projectLinks[0]?.querySelector('span')?.getBoundingClientRect();
          return {
            projectNames: projectLinks.map((item) => item.textContent?.trim()),
            projectIds: projectLinks.map((item) => item.getAttribute('data-hq-project-link')),
            visibleChats: chatRows.length,
            subagentRows: chatRows.filter((item) => item.textContent?.includes('Subagent')).length,
            more,
            scrollClient: scroll?.clientHeight ?? 0,
            scrollHeight: scroll?.scrollHeight ?? 0,
            viewportHeight: window.innerHeight,
            shellHeight: document.querySelector('[data-hq-shell]')?.getBoundingClientRect().height ?? 0,
            groupIconLeft: groupIcon?.left ?? null,
            projectIconLeft: projectIcon?.left ?? null,
            chatIconLeft: chatIcon?.left ?? null,
            projectNameLeft: projectName?.left ?? null,
            chatTitleLefts: chatRows.map((item) => item.querySelector('span')?.getBoundingClientRect().left ?? null)
          };
        })()`);
        assert.deepEqual(initialSidebar.projectNames, [
          "Koed",
          "Research notes",
          "Travel planning",
          "Work"
        ]);
        assert.equal(initialSidebar.visibleChats, 17);
        assert.equal(initialSidebar.subagentRows, 0);
        assert.deepEqual(initialSidebar.more, [
          "Show 1 more",
          "Show 1 more",
          "Show 1 more",
          "Show 1 more",
          "Show 2 more"
        ]);
        assert.ok(
          initialSidebar.scrollHeight > initialSidebar.scrollClient,
          `Expected the long sidebar to scroll at the compact validation height: ${JSON.stringify({ scrollHeight: initialSidebar.scrollHeight, clientHeight: initialSidebar.scrollClient, viewportHeight: initialSidebar.viewportHeight, shellHeight: initialSidebar.shellHeight })}`
        );
        assert.ok(
          Math.abs(
            initialSidebar.projectIconLeft - initialSidebar.groupIconLeft
          ) <= 1,
          `Expected Project and group icons to align: ${JSON.stringify({ projectIconLeft: initialSidebar.projectIconLeft, groupIconLeft: initialSidebar.groupIconLeft })}`
        );
        assert.ok(
          initialSidebar.chatTitleLefts.every(
            (left) =>
              left !== null &&
              Math.abs(left - initialSidebar.projectNameLeft) <= 1
          ),
          `Expected all Conversation titles, including loose Chats, and Project text to align: ${JSON.stringify({ chatTitleLefts: initialSidebar.chatTitleLefts, projectNameLeft: initialSidebar.projectNameLeft })}`
        );

        await window.webContents.executeJavaScript(
          "document.querySelector('.hq-sidebar__more')?.click()"
        );
        await delay(20);
        const expandedChats = await window.webContents.executeJavaScript(
          "document.querySelectorAll('[data-hq-chat-title]').length"
        );
        assert.equal(expandedChats, 18);

        const scrollBeforeNavigation = await window.webContents
          .executeJavaScript(`(() => {
          const scroll = document.querySelector('[data-hq-sidebar-scroll]');
          scroll.scrollTop = Math.floor((scroll.scrollHeight - scroll.clientHeight) / 2);
          scroll.dispatchEvent(new Event('scroll'));
          return scroll.scrollTop;
        })()`);
        assert.ok(scrollBeforeNavigation > 0);

        const projectTarget = initialSidebar.projectIds[0];
        await window.webContents.executeJavaScript(
          `document.querySelector('[data-hq-project-link="${projectTarget}"]')?.click()`
        );
        let projectHeading = "";
        for (let attempt = 0; attempt < 40; attempt += 1) {
          projectHeading = await window.webContents.executeJavaScript(
            "document.querySelector('[data-hq-route=project]')?.getAttribute('aria-label')?.trim() ?? ''"
          );
          if (projectHeading) break;
          await delay(25);
        }
        assert.ok(projectHeading.includes("Koed"));
        const scrollAfterProject = await window.webContents.executeJavaScript(
          "document.querySelector('[data-hq-sidebar-scroll]')?.scrollTop ?? -1"
        );
        assert.equal(scrollAfterProject, scrollBeforeNavigation);

        await window.webContents.executeJavaScript(
          `document.querySelector(${JSON.stringify('[data-hq-chat-row][data-hq-chat-project="hq103-koed"]')})?.click()`
        );
        let sessionHeading = "";
        for (let attempt = 0; attempt < 40; attempt += 1) {
          sessionHeading = await window.webContents.executeJavaScript(
            "document.querySelector('[data-hq-route=conversation]')?.getAttribute('aria-label')?.trim() ?? ''"
          );
          if (sessionHeading) break;
          await delay(25);
        }
        assert.ok(sessionHeading.includes("Conversation"));
        const scrollAfterConversation =
          await window.webContents.executeJavaScript(
            "document.querySelector('[data-hq-sidebar-scroll]')?.scrollTop ?? -1"
          );
        assert.equal(scrollAfterConversation, scrollBeforeNavigation);
        assert.equal(
          await window.webContents.executeJavaScript(
            "document.querySelectorAll('[data-selected=true]').length"
          ),
          1
        );

        const legacyMounted = await window.webContents.executeJavaScript(
          "Boolean(document.querySelector('[data-personal-route-focus], .desktop-event-inspector, .desktop-preferences, .native-inspect-event'))"
        );
        assert.equal(legacyMounted, false);

        await window.webContents.executeJavaScript(`(() => {
          const group = document.querySelector('[data-hq-sidebar-group="just-me"]');
          group.click();
        })()`);
        await delay(20);
        const collapsed = await window.webContents.executeJavaScript(
          "document.querySelector('#hq-group-just-me')?.hasAttribute('hidden') ?? false"
        );
        assert.equal(collapsed, true);
        await window.webContents.executeJavaScript(
          `document.querySelector('[data-hq-sidebar-group="just-me"]')?.click()`
        );
        await delay(20);
        const folds = await window.webContents.executeJavaScript(`(() => ({
          expanded: !(document.querySelector('#hq-group-just-me')?.hasAttribute('hidden') ?? true),
          newProjectDisabled: document.querySelector('button[aria-label="New project"]')?.disabled === true,
          nowEnabled: document.querySelector('button[aria-label="Now"]')?.disabled === false,
          newChatEnabled: document.querySelector('button[aria-label="New chat"]')?.disabled === false,
          searchLabel: document.querySelector('button[aria-label="Search and commands"]')?.getAttribute('aria-label')
        }))()`);
        assert.equal(folds.expanded, true);
        assert.equal(folds.newProjectDisabled, true);
        assert.equal(folds.nowEnabled, true);
        assert.equal(folds.newChatEnabled, true);
        assert.equal(folds.searchLabel, "Search and commands");

        const paletteSelector =
          '[role="dialog"][aria-label="Search and commands"]';
        const waitForPalette = async (expectedOpen) => {
          let actualOpen = false;
          for (let attempt = 0; attempt < 20; attempt += 1) {
            actualOpen = await window.webContents.executeJavaScript(
              `Boolean(document.querySelector(${JSON.stringify(paletteSelector)}))`
            );
            if (actualOpen === expectedOpen) return;
            await delay(20);
          }
          assert.equal(actualOpen, expectedOpen);
        };
        const closePalette = async () => {
          await window.webContents.executeJavaScript(
            `document.querySelector(${JSON.stringify(`${paletteSelector} button[aria-label="Close"]`)})?.click()`
          );
          await waitForPalette(false);
        };

        await window.webContents.executeJavaScript(
          `document.querySelector('button[aria-label="Search and commands"]')?.click()`
        );
        await waitForPalette(true);
        const searchPalette = await window.webContents
          .executeJavaScript(`(() => {
          const previousDark = document.documentElement.classList.contains('dark');
          const popup = document.querySelector('.hq-search');
          const result = [];
          for (const dark of [false, true]) {
            document.documentElement.classList.toggle('dark', dark);
            const style = getComputedStyle(popup);
            result.push({ background: style.backgroundColor, foreground: style.color });
          }
          document.documentElement.classList.toggle('dark', previousDark);
          return result;
        })()`);
        assert.deepEqual(searchPalette, [
          { background: "rgb(241, 241, 244)", foreground: "rgb(24, 24, 27)" },
          { background: "rgb(19, 19, 23)", foreground: "rgb(244, 244, 245)" }
        ]);
        await window.webContents.executeJavaScript(
          `document.querySelector('[id="hq-search-project:hq103-koed"]')?.click()`
        );
        await waitForPalette(false);
        const searchSelection = await window.webContents.executeJavaScript(
          "document.querySelector('[data-hq-route=project]')?.getAttribute('data-hq-project-id')"
        );
        assert.equal(searchSelection, "hq103-koed");
        assert.equal(
          await window.webContents.executeJavaScript(
            "Boolean(document.querySelector('[data-personal-route-focus], .native-inspect-event'))"
          ),
          false
        );

        for (const modifier of ["metaKey", "ctrlKey"]) {
          await window.webContents.executeJavaScript(
            `window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'k', ${modifier}: true }))`
          );
          await waitForPalette(true);
          await closePalette();
        }
      }
    );

    await debuggerClient.sendCommand("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false
    });
    await delay(60);

    const pointerResize = async (selector, deltaX) => {
      const bounds = await window.webContents.executeJavaScript(`(() => {
        const handle = document.querySelector(${JSON.stringify(selector)});
        if (!handle) return null;
        const rect = handle.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`);
      assert.ok(bounds, `Expected resize handle ${selector}.`);
      await debuggerClient.sendCommand("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: bounds.x,
        y: bounds.y,
        button: "left",
        clickCount: 1
      });
      await debuggerClient.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: bounds.x + deltaX,
        y: bounds.y,
        button: "left",
        buttons: 1
      });
      await debuggerClient.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: bounds.x + deltaX,
        y: bounds.y,
        button: "left",
        clickCount: 1
      });
      await delay(30);
      return window.webContents.executeJavaScript(
        `document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-valuenow') ?? null`
      );
    };

    const sidebarBeforeDrag = mounted.sidebarWidth;
    const sidebarAfterDrag = await pointerResize(
      "[data-hq-sidebar-handle]",
      52
    );
    await window.webContents.executeJavaScript(
      "document.querySelector('[data-hq-sidebar-handle]')?.focus()"
    );
    await debuggerClient.sendCommand("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "ArrowLeft",
      code: "ArrowLeft",
      windowsVirtualKeyCode: 37
    });
    await debuggerClient.sendCommand("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "ArrowLeft",
      code: "ArrowLeft",
      windowsVirtualKeyCode: 37
    });
    const sidebarAfterKey = await window.webContents.executeJavaScript(
      "document.querySelector('[data-hq-sidebar-handle]')?.getAttribute('aria-valuenow') ?? null"
    );
    assert.equal(Number(sidebarAfterDrag), Number(sidebarBeforeDrag) + 52);
    assert.equal(Number(sidebarAfterKey), Number(sidebarAfterDrag) - 8);

    const contextBeforeDrag = mounted.contextWidth;
    const contextAfterDrag = await pointerResize(
      "[data-hq-context-handle]",
      -36
    );
    assert.equal(Number(contextAfterDrag), contextBeforeDrag + 36);
    await window.webContents.executeJavaScript(
      "document.querySelector('[data-hq-context-handle]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))"
    );
    await delay(30);
    const contextAfterReset = await window.webContents.executeJavaScript(
      "document.querySelector('[data-hq-context-handle]')?.getAttribute('aria-valuenow') ?? null"
    );
    assert.equal(Number(contextAfterReset), contextBeforeDrag);

    await debuggerClient.sendCommand("Emulation.setDeviceMetricsOverride", {
      width: 761,
      height: 844,
      deviceScaleFactor: 1,
      mobile: false
    });
    await delay(60);
    const hideContext = await window.webContents.executeJavaScript(`(() => {
      const button = document.querySelector('button[aria-label="Hide project context"]');
      button?.click();
      return Boolean(button);
    })()`);
    assert.equal(hideContext, true);
    await delay(30);
    const narrowSidebarWidth = await pointerResize(
      "[data-hq-sidebar-handle]",
      -300
    );
    assert.equal(Number(narrowSidebarWidth), 200);
    const narrowSidebar = await window.webContents.executeJavaScript(`(() => ({
      sidebar: Boolean(document.querySelector('aside[aria-label="Project navigation"]')),
      dialog: Boolean(document.querySelector('[role="dialog"]')),
      context: Boolean(document.querySelector('[data-hq-context]')),
      workspaceWidth: document.querySelector('[data-hq-workspace-layout]')?.getBoundingClientRect().width ?? 0
    }))()`);
    assert.equal(narrowSidebar.sidebar, true);
    assert.equal(narrowSidebar.dialog, false);
    assert.equal(narrowSidebar.context, false);
    assert.ok(narrowSidebar.workspaceWidth >= 540);
    await captureScreenshot("hq-shell-narrow-sidebar.png");

    await debuggerClient.sendCommand("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true
    });
    await delay(60);
    await captureScreenshot("hq103-narrow-sidebar-closed-context.png");
    await runAssertion(
      "HQ103 narrow navigation drawer keeps one mounted sidebar and routes Projects and Conversations",
      async () => {
        const openNavigation = async () => {
          await window.webContents.executeJavaScript(
            "document.querySelector('button[aria-label=\"Show project navigation\"]')?.click()"
          );
          let drawer = null;
          for (let attempt = 0; attempt < 20; attempt += 1) {
            drawer = await window.webContents.executeJavaScript(`(() => ({
              dialog: Boolean(document.querySelector('[data-hq-sidebar-dialog][role="dialog"][aria-modal="true"]')),
              sidebarCount: document.querySelectorAll('#hq-project-navigation').length,
              sidebarLeft: Math.round(document.querySelector('.hq-sidebar')?.getBoundingClientRect().left ?? 0),
              sidebarWidth: Math.round(document.querySelector('.hq-sidebar')?.getBoundingClientRect().width ?? 0),
              expectedSidebarWidth: Math.min(280, window.innerWidth - 32),
              focus: document.activeElement?.getAttribute('aria-label') ?? null,
              workspaceInert: document.querySelector('.hq-shell__workspace')?.hasAttribute('inert') ?? false
            }))()`);
            if (
              drawer.dialog &&
              Math.abs(drawer.sidebarLeft) <= 1 &&
              Math.abs(drawer.sidebarWidth - drawer.expectedSidebarWidth) <= 1
            ) {
              break;
            }
            await delay(20);
          }
          assert.deepEqual(drawer, {
            dialog: true,
            sidebarCount: 1,
            sidebarLeft: drawer.sidebarLeft,
            sidebarWidth: drawer.expectedSidebarWidth,
            expectedSidebarWidth: drawer.expectedSidebarWidth,
            focus: "Close project navigation",
            workspaceInert: true
          });
          assert.ok(
            Math.abs(drawer.sidebarLeft) <= 1,
            `Expected the navigation drawer to finish its slide at the viewport edge: ${drawer.sidebarLeft}`
          );
        };

        const closed = await window.webContents.executeJavaScript(`(() => ({
          opener: Boolean(document.querySelector('button[aria-label="Show project navigation"]')),
          sidebarCount: document.querySelectorAll('#hq-project-navigation').length,
          hidden: document.querySelector('.hq-sidebar')?.getAttribute('aria-hidden') ?? null
        }))()`);
        assert.deepEqual(closed, {
          opener: true,
          sidebarCount: 1,
          hidden: "true"
        });
        await window.webContents.executeJavaScript(
          `document.querySelector('[data-hq-sidebar-group="just-me"]')?.click()`
        );
        assert.equal(
          await window.webContents.executeJavaScript(
            "document.querySelector('#hq-group-just-me')?.hasAttribute('hidden') ?? false"
          ),
          true
        );
        await openNavigation();
        const foldedFocusWrap = await window.webContents
          .executeJavaScript(`(() => {
          const dialog = document.querySelector('[data-hq-sidebar-dialog]');
          dialog.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Tab', shiftKey: true }));
          const shiftTabTarget = document.activeElement?.matches('button.hq-account') ? 'account' : document.activeElement?.getAttribute('data-hq-sidebar-group') ?? null;
          dialog.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Tab' }));
          return {
            shiftTabTarget,
            tabTarget: document.activeElement?.getAttribute('aria-label') ?? null,
            hiddenChildFocused: Boolean(document.querySelector('#hq-group-just-me button:focus'))
          };
        })()`);
        assert.deepEqual(foldedFocusWrap, {
          shiftTabTarget: "account",
          tabTarget: "Close project navigation",
          hiddenChildFocused: false
        });
        await window.webContents.executeJavaScript(
          `document.querySelector('[data-hq-sidebar-group="just-me"]')?.click()`
        );
        assert.equal(
          await window.webContents.executeJavaScript(
            "document.querySelector('#hq-group-just-me')?.hasAttribute('hidden') ?? true"
          ),
          false
        );
        await captureScreenshot(
          "hq103-v50-phone-sidebar-crop.png",
          ".hq-sidebar"
        );
        await window.webContents.executeJavaScript(`(() => {
          const scroll = document.querySelector('[data-hq-sidebar-scroll]');
          scroll.scrollTop = Math.floor((scroll.scrollHeight - scroll.clientHeight) / 2);
          scroll.dispatchEvent(new Event('scroll'));
          window.hq103DrawerScrollBeforeClose = scroll.scrollTop;
        })()`);
        assert.ok(
          await window.webContents.executeJavaScript(
            "window.hq103DrawerScrollBeforeClose > 0"
          )
        );
        await captureScreenshot("hq103-mobile-sidebar-drawer.png");
        const phoneOpener = await window.webContents.executeJavaScript(
          `(() => { const opener=document.querySelector('.hq-mobile-navigation-trigger').getBoundingClientRect(); const title=document.querySelector('.hq-main__heading').getBoundingClientRect(); return {opener:opener.x,title:title.x}; })()`
        );
        assert.ok(phoneOpener.opener < phoneOpener.title);
        await window.webContents.executeJavaScript(
          `document.querySelector('[data-hq-sidebar-dialog]')?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }))`
        );
        await delay(20);
        let afterEscape = await window.webContents.executeJavaScript(`(() => ({
          dialog: Boolean(document.querySelector('[data-hq-sidebar-dialog][role="dialog"]')),
          focusRestored: document.activeElement === document.querySelector('button[aria-label="Show project navigation"]'),
          hidden: document.querySelector('.hq-sidebar')?.getAttribute('aria-hidden') ?? null
        }))()`);
        assert.deepEqual(afterEscape, {
          dialog: false,
          focusRestored: true,
          hidden: "true"
        });

        await openNavigation();
        const scrollAfterReopen = await window.webContents.executeJavaScript(
          "document.querySelector('[data-hq-sidebar-scroll]')?.scrollTop ?? -1"
        );
        assert.equal(
          scrollAfterReopen,
          await window.webContents.executeJavaScript(
            "window.hq103DrawerScrollBeforeClose"
          )
        );
        await window.webContents.executeJavaScript(
          `document.querySelector('[data-hq-project-link="hq103-notes"]')?.click()`
        );
        let selectedProject = "";
        for (let attempt = 0; attempt < 40; attempt += 1) {
          selectedProject = await window.webContents.executeJavaScript(
            "document.querySelector('[data-hq-route=project]')?.getAttribute('aria-label')?.trim() ?? ''"
          );
          if (selectedProject.includes("Research notes")) break;
          await delay(25);
        }
        assert.ok(selectedProject.includes("Research notes"));
        assert.equal(
          await window.webContents.executeJavaScript(
            "Boolean(document.querySelector('[data-hq-sidebar-dialog][role=\"dialog\"]'))"
          ),
          false
        );

        await openNavigation();
        await window.webContents.executeJavaScript(
          `document.querySelector('[data-hq-chat-row][data-hq-chat-project="hq103-notes"]')?.click()`
        );
        let selectedConversation = "";
        for (let attempt = 0; attempt < 40; attempt += 1) {
          selectedConversation = await window.webContents.executeJavaScript(
            "document.querySelector('[data-hq-route=conversation]')?.getAttribute('aria-label')?.trim() ?? ''"
          );
          if (selectedConversation.includes("Conversation")) break;
          await delay(25);
        }
        assert.ok(selectedConversation.includes("Conversation"));
        assert.equal(
          await window.webContents.executeJavaScript(
            'Boolean(document.querySelector(\'button[aria-label="Show project context"], button[aria-label="Hide project context"]\'))'
          ),
          false
        );
        assert.equal(
          await window.webContents.executeJavaScript(
            "Boolean(document.querySelector('[data-hq-sidebar-dialog][role=\"dialog\"]'))"
          ),
          false
        );
        assert.equal(
          await window.webContents.executeJavaScript(
            "document.querySelectorAll('#hq-project-navigation').length"
          ),
          1
        );
        await openNavigation();
        await window.webContents.executeJavaScript(
          `document.querySelector('[data-hq-project-link="hq103-koed"]')?.click()`
        );
        assert.equal(
          await window.webContents.executeJavaScript(
            'Boolean(document.querySelector(\'button[aria-label="Show project context"], button[aria-label="Hide project context"]\'))'
          ),
          true
        );
      }
    );
    await runAssertion(
      "HQ103 keyboard commands transfer phone focus between replacement overlays",
      async () => {
        const press = async (
          key,
          code,
          windowsVirtualKeyCode,
          modifiers = 0
        ) => {
          await debuggerClient.sendCommand("Input.dispatchKeyEvent", {
            type: "keyDown",
            key,
            code,
            windowsVirtualKeyCode,
            modifiers
          });
          await debuggerClient.sendCommand("Input.dispatchKeyEvent", {
            type: "keyUp",
            key,
            code,
            windowsVirtualKeyCode,
            modifiers
          });
        };
        const searchCommand = async (label) => {
          await press("k", "KeyK", 75, 4);
          let inputFocused = false;
          for (let attempt = 0; attempt < 40; attempt += 1) {
            inputFocused = await window.webContents.executeJavaScript(
              "document.activeElement === document.querySelector('.hq-search input')"
            );
            if (inputFocused) break;
            await delay(25);
          }
          assert.equal(inputFocused, true);
          await debuggerClient.sendCommand("Input.insertText", { text: label });
          await press("Enter", "Enter", 13);
        };
        const expectOverlayFocus = async (label) => {
          let focus;
          for (let attempt = 0; attempt < 40; attempt += 1) {
            focus = await window.webContents.executeJavaScript(
              `(() => ({ label:document.activeElement?.getAttribute('aria-label') ?? null, inert:Boolean(document.activeElement?.closest('[inert]')), palette:Boolean(document.querySelector('.hq-search')) }))()`
            );
            if (focus.label === label && !focus.palette) break;
            await delay(25);
          }
          assert.deepEqual(focus, { label, inert: false, palette: false });
        };
        await window.webContents.executeJavaScript(
          "document.querySelector('.hq-mobile-navigation-trigger')?.click()"
        );
        await expectOverlayFocus("Close project navigation");
        await searchCommand("Toggle context panel");
        await expectOverlayFocus("Close project context");
        assert.equal(
          await window.webContents.executeJavaScript(
            "Boolean(document.querySelector('[data-hq-sidebar-dialog][role=dialog]'))"
          ),
          false
        );
        await searchCommand("Toggle sidebar");
        await expectOverlayFocus("Close project navigation");
        assert.equal(
          await window.webContents.executeJavaScript(
            "Boolean(document.querySelector('#hq-context-dialog'))"
          ),
          false
        );
        await press("Escape", "Escape", 27);
      }
    );
    const mobile = await window.webContents.executeJavaScript(`(() => {
      const trigger = document.querySelector('button[aria-label="Show project context"]');
      trigger?.click();
      return Boolean(trigger);
    })()`);
    assert.equal(mobile, true);
    await delay(20);
    const mobileModal = await window.webContents.executeJavaScript(`(() => {
      const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
      const close = dialog?.querySelector('button[aria-label="Close project context"]');
      return {
        dialog: Boolean(dialog),
        inert: document.querySelector('.hq-shell__layout')?.hasAttribute('inert') ?? false,
        closeFocused: document.activeElement === close
      };
    })()`);
    assert.deepEqual(mobileModal, {
      dialog: true,
      inert: true,
      closeFocused: true
    });
    await captureScreenshot("hq-shell-narrow.png");
    await window.webContents.executeJavaScript(
      `document.querySelector('[role="dialog"]')?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }))`
    );
    await delay(20);
    const mobileAfterEscape = await window.webContents
      .executeJavaScript(`(() => {
      const opener = document.querySelector('button[aria-label="Show project context"]');
      return {
        dialog: Boolean(document.querySelector('[role="dialog"]')),
        inert: document.querySelector('.hq-shell__layout')?.hasAttribute('inert') ?? false,
        focusRestored: document.activeElement === opener
      };
    })()`);
    assert.deepEqual(mobileAfterEscape, {
      dialog: false,
      inert: false,
      focusRestored: true
    });

    await runAssertion(
      "HQ109 Settings integration (approved compound IDs remain SKIP)",
      async () => {
        await validateHqSettings({ window, debuggerClient, repoRoot, delay });
      }
    );

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
        browserReady: document.documentElement.dataset.browserValidationReady === 'true'
      };
    })()`);

    await runAssertion("Scaffold/fixture smoke", async () => {
      assert.equal(mounted.shellCount, 1);
      assert.equal(mounted.shellTag, "DIV");
      assert.equal(mounted.shellChildren, 1);
      assert.equal(mounted.hasProjectNavigation, true);
      assert.equal(mounted.hasWorkspace, true);
      assert.equal(mounted.hasContext, true);
      assert.equal(mounted.hasSidebarHandle, true);
      assert.equal(mounted.hasContextHandle, true);
      assert.equal(fixture.fixtureId, expectedFixtureId);
      assert.deepEqual(fixture.identities, expectedFixtureIdentities);
      assert.deepEqual(
        fixture.snapshot.projects.map(({ id }) => id),
        expectedFixtureIdentities
      );
      assert.equal(fixture.fixedAt, "2026-10-19T09:00:00.000Z");
      assert.equal(fixture.projects, 5);
      assert.equal(fixture.conversations, 5);
      assert.equal(fixture.privateHqConversations, 9);
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
      assert.deepEqual(
        fixture.snapshot.privateHqConversations
          .filter(({ owner }) => owner === "You")
          .map(({ projectId }) => projectId)
          .sort(),
        [...expectedFixtureIdentities].sort()
      );
      assert.deepEqual(
        fixture.snapshot.privateHqConversations
          .filter(({ owner }) => owner !== "You")
          .map(({ projectId, owner }) => `${projectId}:${owner}`)
          .sort(),
        [
          "econ-101:Lena",
          "econ-101:Omar",
          "investor-deck:Sam",
          "koed-main:Mark"
        ]
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
      assert.equal(fixture.browserReady, true);
      assert.deepEqual(rendererErrors, []);
      assert.deepEqual(rendererExceptions, []);
    });

    await runAssertion(
      "HQ104 composer and timeline (ticket-owned proof; S11.1 remains SKIP)",
      async () => {
        await debuggerClient.sendCommand("Emulation.setDeviceMetricsOverride", {
          width: 1280,
          height: 800,
          deviceScaleFactor: 1,
          mobile: false
        });
        let desktopSidebarWidth = null;
        for (let attempt = 0; attempt < 40; attempt += 1) {
          desktopSidebarWidth = await window.webContents
            .executeJavaScript(`(() => {
            const handle = document.querySelector('[data-hq-sidebar-handle]');
            const rect = handle?.getBoundingClientRect();
            const width = Number(handle?.getAttribute('aria-valuenow'));
            return window.innerWidth === 1280 &&
              !window.matchMedia('(max-width: 760px)').matches &&
              rect?.width > 0 && rect?.height > 100 &&
              Number.isFinite(width) && width >= 200
                ? width : null;
          })()`);
          if (desktopSidebarWidth !== null) break;
          await delay(25);
        }
        assert.ok(
          desktopSidebarWidth !== null,
          "HQ104 desktop sidebar handle did not become ready"
        );
        if (desktopSidebarWidth !== 268)
          await window.webContents.executeJavaScript(
            `document.querySelector('[data-hq-sidebar-handle]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`
          );
        let restoredSidebarWidth = null;
        for (let attempt = 0; attempt < 40; attempt += 1) {
          restoredSidebarWidth = await window.webContents
            .executeJavaScript(`(() => {
            const handle = document.querySelector('[data-hq-sidebar-handle]');
            const rect = handle?.getBoundingClientRect();
            const width = Number(handle?.getAttribute('aria-valuenow'));
            const sidebarWidth = Math.round(document.querySelector('.hq-sidebar')?.getBoundingClientRect().width ?? 0);
            return rect?.width > 0 && rect?.height > 100 && width === 268 && sidebarWidth === 268
              ? width : null;
          })()`);
          if (restoredSidebarWidth !== null) break;
          await delay(25);
        }
        assert.equal(Number(restoredSidebarWidth), 268);
        await window.webContents.executeJavaScript(
          `document.querySelector('button[aria-label="New chat"]')?.click()`
        );
        for (let attempt = 0; attempt < 40; attempt += 1) {
          const ready = await window.webContents.executeJavaScript(
            `Boolean(document.querySelector('[aria-label="Project: Chats"]') && document.querySelector('[aria-label="Permissions: Ask first"]') && document.querySelector('[aria-label^="Model and reasoning: GPT-5.5"]'))`
          );
          if (ready) break;
          await delay(50);
        }
        const blank = await window.webContents.executeJavaScript(`(() => {
        const composer = document.querySelector('.hq-composer');
        const rect = composer?.getBoundingClientRect();
        return {
          composer: Boolean(composer),
          width: Math.round(rect?.width ?? 0),
          height: Math.round(rect?.height ?? 0),
          project: document.querySelector('[aria-label^="Project:"]')?.getAttribute('aria-label'),
          permission: document.querySelector('[aria-label^="Permissions:"]')?.getAttribute('aria-label'),
          model: document.querySelector('[aria-label^="Model and reasoning:"]')?.getAttribute('aria-label'),
          legacy: Boolean(document.querySelector('.native-conversation-surface'))
        };
      })()`);
        assert.equal(blank.composer, true);
        assert.equal(blank.width, 760);
        assert.ok(blank.height >= 93 && blank.height < 110);
        assert.equal(blank.project, "Project: Chats");
        assert.equal(blank.permission, "Permissions: Ask first");
        assert.ok(blank.model?.includes("GPT-5.5"));
        assert.equal(blank.legacy, false);
        assert.equal(
          await window.webContents.executeJavaScript(
            'Boolean(document.querySelector(\'button[aria-label="Show project context"], button[aria-label="Hide project context"]\'))'
          ),
          false
        );
        await captureScreenshot("hq104-blank-desktop.png");
        await window.webContents.executeJavaScript(
          `document.documentElement.classList.replace('dark', 'light')`
        );
        await captureScreenshot("hq104-blank-desktop-light.png");
        await window.webContents.executeJavaScript(
          `document.documentElement.classList.replace('light', 'dark')`
        );

        await window.webContents.executeJavaScript(
          `document.querySelector('[aria-label^="Model and reasoning:"]')?.click()`
        );
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const settled = await window.webContents.executeJavaScript(
            `Boolean(document.querySelector('.hq-reasoning__bars button[aria-label="Reasoning effort: Medium"]') && getComputedStyle(document.querySelector('.hq-conversation-menu--model')).opacity === '1')`
          );
          if (settled) break;
          await delay(25);
        }
        assert.equal(
          await window.webContents.executeJavaScript(
            `Boolean(document.querySelector('.hq-reasoning__bars button[aria-label="Reasoning effort: Medium"]'))`
          ),
          true
        );
        await captureScreenshot("hq104-model-reasoning-desktop.png");
        await window.webContents.executeJavaScript(
          `document.documentElement.classList.replace('dark', 'light')`
        );
        await captureScreenshot("hq104-model-reasoning-desktop-light.png");
        await window.webContents.executeJavaScript(
          `document.documentElement.classList.replace('light', 'dark')`
        );
        await window.webContents.executeJavaScript(
          `document.querySelector('[aria-label="Choose AI Client and model"]')?.click()`
        );
        assert.equal(
          await window.webContents.executeJavaScript(
            `Boolean([...document.querySelectorAll('[role="menuitemradio"]')].some((item) => item.textContent.includes('GPT-5.5')))`
          ),
          true
        );
        await captureScreenshot("hq104-model-list-desktop.png");
        await window.webContents.executeJavaScript(
          `document.querySelector('[aria-label^="Model and reasoning:"]')?.click()`
        );

        await window.webContents.executeJavaScript(
          `document.querySelector('[aria-label^="Permissions:"]')?.click()`
        );
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const settled = await window.webContents.executeJavaScript(
            `(() => { const menu=document.querySelector('.hq-conversation-menu'); if (!menu) return false; const style=getComputedStyle(menu); return style.opacity === '1' && style.backgroundColor.startsWith('rgb('); })()`
          );
          if (settled) break;
          await delay(25);
        }
        assert.equal(
          await window.webContents.executeJavaScript(
            `(() => { const menu=document.querySelector('.hq-conversation-menu'); if (!menu) return false; const style=getComputedStyle(menu); return style.opacity === '1' && style.backgroundColor.startsWith('rgb('); })()`
          ),
          true
        );
        const modes = await window.webContents.executeJavaScript(
          `[...document.querySelectorAll('[role="menuitemradio"]')].map((item) => item.textContent.trim())`
        );
        assert.ok(modes.some((label) => label.includes("Ask first")));
        assert.ok(modes.some((label) => label.includes("Full access")));
        assert.equal(
          modes.some((label) => label.includes("Auto-accept edits")),
          false
        );
        await captureScreenshot("hq104-permissions-desktop.png");
        await window.webContents.executeJavaScript(
          `document.documentElement.classList.replace('dark', 'light')`
        );
        await captureScreenshot("hq104-permissions-desktop-light.png");
        await window.webContents.executeJavaScript(
          `document.documentElement.classList.replace('light', 'dark')`
        );
        await window.webContents.executeJavaScript(
          `document.querySelector('[aria-label^="Permissions:"]')?.click()`
        );
        await debuggerClient.sendCommand("Emulation.setDeviceMetricsOverride", {
          width: 390,
          height: 844,
          deviceScaleFactor: 1,
          mobile: true
        });
        await delay(260);
        const assertPhoneEffort = async (width) => {
          const layout = await window.webContents.executeJavaScript(`(() => {
            const toolbar = document.querySelector('.hq-composer__toolbar');
            const model = toolbar?.querySelector('.hq-composer__model-trigger');
            const effort = model?.querySelector('.hq-composer__effort-label');
            const send = toolbar?.querySelector('.hq-composer__send');
            const toolbarRect = toolbar?.getBoundingClientRect();
            const modelRect = model?.getBoundingClientRect();
            const sendRect = send?.getBoundingClientRect();
            return {
              effort: effort?.textContent?.trim() ?? '',
              visible: Boolean(effort && getComputedStyle(effort).display !== 'none' && effort.getBoundingClientRect().width > 0),
              oneRow: Boolean(toolbarRect && modelRect && sendRect && Math.abs((modelRect.top + modelRect.bottom) / 2 - (sendRect.top + sendRect.bottom) / 2) < 4 && modelRect.right <= sendRect.left && sendRect.right <= toolbarRect.right + 1)
            };
          })()`);
          assert.deepEqual(
            layout,
            { effort: "Medium", visible: true, oneRow: true },
            `Phone ${width}px reasoning control`
          );
        };
        await assertPhoneEffort(390);
        await captureScreenshot("hq104-blank-phone390.png");
        await debuggerClient.sendCommand("Emulation.setDeviceMetricsOverride", {
          width: 320,
          height: 700,
          deviceScaleFactor: 1,
          mobile: true
        });
        await delay(260);
        await assertPhoneEffort(320);
        await captureScreenshot("hq104-blank-phone320.png");
        await debuggerClient.sendCommand("Emulation.setDeviceMetricsOverride", {
          width: 1280,
          height: 800,
          deviceScaleFactor: 1,
          mobile: false
        });
        await window.webContents.executeJavaScript(`(() => {
        const input = document.querySelector('textarea[aria-label="Message your AI Client"]');
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(input, 'Plan the next release');
        input.dispatchEvent(new InputEvent('input', { bubbles: true }));
      })()`);
        await window.webContents.executeJavaScript(
          `document.querySelector('button[aria-label="Send message"]')?.click()`
        );
        for (let attempt = 0; attempt < 40; attempt += 1) {
          const ready = await window.webContents.executeJavaScript(
            `Boolean(document.querySelector('.hq-conversation__dock') && document.body.textContent.includes('I can help with that.'))`
          );
          if (ready) break;
          await delay(50);
        }
        const active = await window.webContents.executeJavaScript(`(() => ({
        route: document.querySelector('[data-hq-route]')?.getAttribute('data-hq-route'),
        project: document.querySelector('[data-hq-project-id]')?.getAttribute('data-hq-project-id'),
        sent: document.body.textContent.includes('Plan the next release'),
        reply: document.body.textContent.includes('I can help with that.'),
        dock: Math.round(document.querySelector('.hq-conversation__dock .hq-composer')?.getBoundingClientRect().width ?? 0)
      }))()`);
        assert.deepEqual(active, {
          route: "conversation",
          project: "hq103-loose",
          sent: true,
          reply: true,
          dock: 780
        });
        await captureScreenshot("hq104-conversation-desktop.png");
        await window.webContents.executeJavaScript(
          `document.documentElement.classList.replace('dark', 'light')`
        );
        await captureScreenshot("hq104-conversation-desktop-light.png");
        await window.webContents.executeJavaScript(
          `document.documentElement.classList.replace('light', 'dark')`
        );

        await debuggerClient.sendCommand("Emulation.setDeviceMetricsOverride", {
          width: 390,
          height: 844,
          deviceScaleFactor: 1,
          mobile: true
        });
        await delay(260);
        await assertPhoneEffort(390);
        const phoneWidth = await window.webContents.executeJavaScript(
          `Math.round(document.querySelector('.hq-conversation__dock .hq-composer')?.getBoundingClientRect().width ?? 0)`
        );
        assert.ok(
          phoneWidth >= 340 && phoneWidth <= 358,
          `Phone composer width ${phoneWidth}`
        );
        await captureScreenshot("hq104-conversation-phone390.png");
        await debuggerClient.sendCommand("Emulation.setDeviceMetricsOverride", {
          width: 320,
          height: 700,
          deviceScaleFactor: 1,
          mobile: true
        });
        await delay(260);
        await assertPhoneEffort(320);
        await captureScreenshot("hq104-conversation-phone320.png");
        assert.deepEqual(rendererErrors, []);
        assert.deepEqual(rendererExceptions, []);
      }
    );

    await runAssertion(
      "HQ105 private visibility line (ticket-owned proof; S20.1 remains SKIP)",
      async () => {
        await debuggerClient.sendCommand("Emulation.setDeviceMetricsOverride", {
          width: 1280,
          height: 800,
          deviceScaleFactor: 1,
          mobile: false
        });
        let desktopReady = false;
        for (let attempt = 0; attempt < 40; attempt += 1) {
          desktopReady = await window.webContents.executeJavaScript(`(() => {
            const form = document.querySelector('.hq-conversation__dock form.hq-composer');
            return window.innerWidth === 1280 &&
              document.querySelector('[data-hq-route]')?.getAttribute('data-hq-route') === 'conversation' &&
              Math.round(form?.getBoundingClientRect().width ?? 0) === 780;
          })()`);
          if (desktopReady) break;
          await delay(25);
        }
        assert.equal(desktopReady, true);
        assert.equal(
          await window.webContents.executeJavaScript(
            `Boolean(document.querySelector('.hq-composer__visibility'))`
          ),
          false,
          "A Conversation without sharing provenance must not claim Just me"
        );
        await window.webContents.executeJavaScript(
          `document.querySelector('button[title="Conversation 91"]')?.click()`
        );
        let active = null;
        for (let attempt = 0; attempt < 40; attempt += 1) {
          active = await window.webContents.executeJavaScript(`(() => {
            const line = document.querySelector('.hq-conversation .hq-composer__visibility');
            const form = document.querySelector('.hq-conversation form.hq-composer');
            return {
              route: document.querySelector('[data-hq-route]')?.getAttribute('data-hq-route'),
              sessionId: document.querySelector('[data-hq-session-id]')?.getAttribute('data-hq-session-id'),
              label: line?.textContent?.trim() ?? null,
              beforeForm: line?.nextElementSibling === form,
              lineHeight: Math.round(line?.getBoundingClientRect().height ?? 0),
              docked: Boolean(document.querySelector('.hq-conversation__dock .hq-composer__visibility')),
              reads: { ...window.__koedHqVisibilityReads }
            };
          })()`);
          if (active?.label === "Just me") break;
          await delay(50);
        }
        assert.equal(active?.route, "conversation");
        assert.equal(active?.sessionId, "00000000-0000-4000-8000-000000000091");
        assert.equal(active?.label, "Just me", JSON.stringify(active));
        assert.equal(active?.docked, true, JSON.stringify(active));
        assert.equal(active?.beforeForm, true);
        assert.equal(active?.lineHeight, 26);
        assert.ok(active?.reads.grants > 0 && active?.reads.shares > 0);
        await window.webContents.executeJavaScript(
          `window.__koedHqVisibilityFixture.setShared(true)`
        );
        let shared = null;
        for (let attempt = 0; attempt < 40; attempt += 1) {
          shared = await window.webContents.executeJavaScript(`(() => ({
            label: document.querySelector('.hq-conversation__dock .hq-composer__visibility')?.textContent?.trim() ?? null,
            grants: window.__koedHqVisibilityReads.grants
          }))()`);
          if (shared?.label === null && shared.grants > active.reads.grants)
            break;
          await delay(25);
        }
        assert.equal(shared?.label, null, JSON.stringify(shared));
        assert.ok(shared?.grants > active.reads.grants);
        await window.webContents.executeJavaScript(
          `window.__koedHqVisibilityFixture.setShared(false)`
        );
        let restored = null;
        for (let attempt = 0; attempt < 40; attempt += 1) {
          restored = await window.webContents.executeJavaScript(`(() => ({
            label: document.querySelector('.hq-conversation__dock .hq-composer__visibility')?.textContent?.trim() ?? null,
            grants: window.__koedHqVisibilityReads.grants,
            shares: window.__koedHqVisibilityReads.shares
          }))()`);
          if (
            restored?.label === "Just me" &&
            restored.grants > shared.grants &&
            restored.shares > active.reads.shares
          )
            break;
          await delay(25);
        }
        assert.equal(restored?.label, "Just me", JSON.stringify(restored));
        assert.ok(restored.grants > shared.grants);
        assert.ok(restored.shares > active.reads.shares);
        await captureScreenshot("hq105-conversation-desktop.png");
        await window.webContents.executeJavaScript(
          `document.documentElement.classList.replace('dark', 'light')`
        );
        await captureScreenshot("hq105-conversation-desktop-light.png");
        await window.webContents.executeJavaScript(
          `document.querySelector('button[aria-label="New chat"]')?.click()`
        );
        let blank = null;
        for (let attempt = 0; attempt < 40; attempt += 1) {
          blank = await window.webContents.executeJavaScript(`(() => {
            const line = document.querySelector('.hq-conversation--blank .hq-composer__visibility');
            return {
              label: line?.textContent?.trim() ?? null,
              beforeForm: line?.nextElementSibling === document.querySelector('.hq-conversation--blank form.hq-composer'),
              lineHeight: Math.round(line?.getBoundingClientRect().height ?? 0)
            };
          })()`);
          if (blank?.label === "Just me" && blank.beforeForm) break;
          await delay(25);
        }
        assert.deepEqual(blank, {
          label: "Just me",
          beforeForm: true,
          lineHeight: 26
        });
        await captureScreenshot("hq105-blank-desktop-light.png");
        await window.webContents.executeJavaScript(
          `document.documentElement.classList.replace('light', 'dark')`
        );
        await captureScreenshot("hq105-blank-desktop.png");
      }
    );

    process.stdout.write(
      `HQ acceptance harness: active scaffold/fixture smoke, HQ-103 sidebar subchecks, HQ-104 composer/timeline proof, HQ-105 private visibility proof, HQ-108 Now home proof, HQ-109 Settings integration, and real Electron layout, drag, keyboard, modal, and screenshot checks passed; ${approvedPositiveIds.length} positive, ${approvedNegativeIds.length} negative, and ${approvedTwoUserIds.length} two-user IDs remain explicit SKIP entries in this browser report. Preference-file and IPC contracts are validated by their native module tests, not by the preload-free fixture window. Screenshots: ${screenshotDir}.\n`
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
