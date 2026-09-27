# Studio New Chat and Build panel

## Agreed behaviour

Keep the imported Personal UI, composer, navigation and Build panel appearance.
New Chat suggestions fill the draft without sending it. Ask before replacing a
non-empty draft. Collaborative chat remains a separate integration slice.

The Build panel is available for every chat, including conversations without a
Project or Git repository. Clicking its compact summary expands it to the available
height on the right. Minimise returns to the compact view; closing it must leave a
way to reopen it. Story and Advanced show the same underlying activity:

- Story describes progress and outcomes in plain language, without code.
- Advanced shows observed technical details when available, including files,
  commands, diffs and test results.
- Missing observations remain unknown, not successful. A clean Git working tree
  does not prove that editor buffers are saved, work is committed, or tests passed.
- An AI Client response is not proof of a completed implementation. Do not derive
  file paths, line counts or successful milestones from message text or hashes.

The expanded panel supports pointer and keyboard resizing within layout bounds.
Suggestions and the composer share a modest left inset from the sidebar, rather
than centring a narrow column across a wide screen. They shrink to fit the
remaining chat area as the Build panel expands. The New
Chat heading does not include a back arrow; the existing sidebar provides navigation.

All chat composers expose access and model controls. In unwired and simulated
chats these are UI preferences, not execution guarantees. A live runtime with a
fixed preset must show its actual model and access level and disable unsupported
choices. In particular, PR Chat remains read-only with its configured model;
displaying these controls does not enable writes or model switching on that path.

## Current implementation boundary

The Studio gateway is a read-only preview. The New Chat UI can be exercised with
explicit synthetic activity, but real execution is not enabled by this slice.
Demo actions must not launch AI Clients or write to the backend. Live mode must
not display synthetic progress as real data. Sample suggestions are not a claim
that personalised recall has been connected.

The imported `buildProgress.ts` fabricates technical counts for the original
prototype. It is a design reference, not an adapter for production activity.

## Next integration slice

Port the existing Desktop managed-conversation contracts instead of creating a
second execution engine. `apps/desktop/src/koed-server/manager.ts` already handles
launch options, runtime snapshots, generation-aware responses, prompts and
interrupt/stop requests. Runtime snapshots include execution generation, state
version, latest command and runtime items. Reuse those identity and ordering
boundaries when feeding both views; inspect the existing diff contract before
presenting aggregate file statistics.

Before exposing writes through Studio, add local session authorization, request
protections, validated inputs and idempotency. Keep credentials out of the
renderer. A hosted browser needs its own authenticated user boundary, not a shared
operator token. Recover from reconnects using durable snapshots and discard stale
events across execution generations or identity changes.

Personalised suggestions require authorized recall and an AI Client to turn
evidence into suggested prompts. Do not introduce backend LLM synthesis into the
self-hosted service. Treat source text as untrusted context, never as authority to
execute a suggestion.

Validate standalone and Project chats, draft replacement, unavailable execution,
panel expand/minimise/close/reopen, both view modes, unknown activity, and demo
isolation before enabling the live send path.
