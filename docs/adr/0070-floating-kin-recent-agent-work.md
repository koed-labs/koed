# Floating Kin Surfaces Recent Agent Work from Personal Memory

Status: Proposed. Early-stage product exploration; the open questions below are unresolved.

Related decisions:

- [0001 AI Client Synthesis Only](./0001-ai-client-synthesis-only.md)
- [0065 Capture and Recall Without Managed Conversation Execution](./0065-capture-and-recall-without-managed-conversation-execution.md) (independent; see Relationship)

## Context

A User often leaves an AI Client working on a long task and wants to know where
it is, what it is doing, and why, without interrupting it or inspecting the
client. Some AI Clients offer side questions for this, but each works only inside
its own client and requires the User to go there.

Koed already captures Conversations from supported AI Clients as Personal Memory,
retrieves evidence from it, and runs AI Client synthesis for Memory Answer. Desktop
already refreshes when captured Conversation events change. What is missing is a
glanceable, cross-client place to see recent activity and ask for a summary.

This decision explores a Clippy-style companion: a small Kin that floats above
other windows. It is a new product direction, not a continuation of Managed
Conversations. Team collaboration is a possible later extension and is not part
of this decision.

## Decision

Explore an opt-in floating Kin in Koed Desktop with this shape:

- The Kin gives a light visual signal when a captured Conversation has recent
  activity. "Active" means Koed has captured new events for it recently. It does
  not mean Koed observes the AI Client live.
- The Kin offers fixed actions, not free text. Initial actions summarize the
  most recently active captured Conversation, and give context from its wider
  Project. Koed builds each question from a template; the Kin sends only an
  action and the target identifiers.
- For a Conversation whose turn is still running, Koed builds the summary from
  the captured timeline of that turn: the raw items Koed has already captured,
  such as tool calls, results, messages, and reasoning. Sealed Memory Events do
  not yet exist for an unfinished turn (see Measurements). For earlier work, Koed
  retrieves evidence from sealed Personal Memory as Memory Answer does.
- The User's connected AI Client synthesizes the answer, using the same local AI
  Client execution path and validation as Memory Answer. The backend makes no LLM
  calls (ADR 0001).
- The answer shows the captured sources it rests on. Koed, not the model,
  computes and displays the time of the newest captured item, so the User can
  judge how current the summary is. The answer distinguishes what was captured
  from what is inferred, particularly when explaining why the work is proceeding
  as it is.
- The Kin is read-only. It does not create, continue, resume, interrupt, or hand
  off a Conversation, and it does not send anything to the AI Client being
  observed.
- It works across every AI Client whose Conversations Koed captures, with the
  same behavior for each.
- The Kin is a Desktop-owned window, shown only while Desktop is running. It
  disappears on Quit Desktop, even if the local runtime stays up for another
  reason.
- When the local runtime or the assigned AI Client is unavailable, the Kin says
  so with one clear action. It never starts a stopped runtime on its own, never
  overrides a durable Stop, and never falls back to a different AI Client.
- The feature is off by default. Enabling it is an explicit User action.

## Relationship to Other Decisions

ADR 0065 set aside Koed-managed Conversation execution, to be possibly revisited
later. This decision does not depend on it, revive it, or settle that question.
The Kin neither starts nor manages an AI Client execution; it asks for one
bounded, read-only synthesis over retrieved evidence, as Memory Answer already
does.

ADR 0001 remains in force and is extended only in who may originate a request:
the User, from Desktop, in addition to an AI Client through the MCP Server. The
synthesis responsibility stays with the AI Client.

## Consequences

- The Kin is only as current as capture. It reflects events Koed has captured and
  can lag the AI Client by the capture delay, so it must present results as of a
  time rather than as live state.
- Desktop gains a new always-on-top surface with its own accessibility, platform,
  and focus requirements.
- Each summary uses the User's AI Client subscription and can incur its usage.
  The effective model, reasoning effort, and errors follow the existing AI Client
  assignment and must be visible to the User. Results can be reused until new
  events arrive.
- The existing Desktop ask route in the Local AI Runtime is currently unused by
  the Desktop interface. Building on it means taking responsibility for it,
  including bounded time, cancellation, and an evidence-bearing reply, none of
  which it provides today.
- Overlay availability follows the Desktop process, not the runtime lifecycle, so
  control-plane or Background Agent work is a dependency for state reporting
  only, not for hosting the Kin.

## Measurements

One run on a fresh local stack: a headless Claude Code session on a small model
ran eight sleep-and-report steps over about 2.5 minutes, observed by polling the
local database. Indicative only: one client, one short run, one model.

- Raw captured items appeared 1.1 to 2.5 seconds after their transcript time
  (median about 1.5 seconds) for tool calls, tool results, agent messages,
  reasoning, and the user message.
- The user's message became a sealed Memory Event after about 4 seconds. The
  agent's whole turn became a single Memory Event only when the turn completed,
  about 168 seconds later.
- A session-scoped Memory Answer asked about 71 seconds into the turn reported
  that the session held only the user's instruction and no agent actions. The same
  question after the turn completed returned an accurate account of all eight
  steps with sources, in about 17 seconds.
- The post-turn answer described the newest activity time incorrectly, so Koed
  must compute that time itself.

Consequence: summarizing running work through Memory Answer alone is not
possible; the Kin must read the captured timeline of the active turn.

Code inspection adds two constraints. Desktop's change event is derived from
sealed Memory Events, so it does not fire as raw items arrive during a turn. No
API currently reads raw captured items for Desktop. The Kin therefore needs a
new owner-scoped read of recent raw items and its own activity signal, and
raw items must honor memory exclusion and any privacy filtering applied to
sealed Memory.

## Open Questions

- Freshness and reasoning capture for Codex and Pi, and for Claude Code on longer
  turns and larger models. How much reasoning each client exposes decides how well
  "why" can be answered.
- Whether Desktop's change event matches database timing.
- How much of a long running turn's timeline is passed to the AI Client, and how
  it is bounded and summarized incrementally.
- How "most recently active" is chosen when several Conversations are active.
- How reasoning is treated when an AI Client does not expose it for capture.
- Whether the Kin uses the existing Memory Answer model assignment or a separate
  one, and how a low-cost model is selected.
- Whether the generated requests and answers are retained, shown in Recall
  activity, or discarded.
- Whether free-text questions are added later, and how that would be bounded.
- How the User shows, hides, and moves the Kin, including a global shortcut.
- Platform scope for the first release.
- Naming: the glossary needs terms for the Kin and for any Chief of Staff
  persona. Customization of the Kin is a separate decision.
- Whether Team collaboration extends the Kin to shared Memory.
- Whether a later handoff to an external AI Client is wanted.

## Alternatives

**Free-text question input:** more flexible, but the overlay would send arbitrary
text and needs text-entry handling in a window that must not take focus. It can be
added later.

**Launcher to an external AI Client:** simple, but the answer lives outside Koed
and requires handing a question and evidence to another process.

**Observe AI Client sessions live:** fresher, but requires a separate integration
with its own privacy implications and is outside this decision.

**Host the Kin in a background process that outlives Desktop:** survives Quit
Desktop, but adds a second UI-owning process and security surface for an
early-stage feature.

**Backend synthesis:** rejected by ADR 0001.

**Revive Managed Conversations for this:** adds the execution and authority
obligations that ADR 0065 set aside.
