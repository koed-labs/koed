# Handoff: Floating Kin (implementation)

Written 2026-11-18. Lives on the throwaway branch `scratch/floating-kin-handoff`
(reference only; never merge). Start from `main` for implementation and copy
what you need. This doc is self-contained: it assumes no access to the original
author's machine.

## Where things are

- Design decision: ADR 0070 is in draft PR #546 (branch `docs/adr-0070-floating-kin`),
  file `docs/adr/0070-floating-kin-recent-agent-work.md`. It is NOT on this
  handoff branch's base unless #546 has merged; read it from that branch.
- Reference mock: `handoff/floating-kin/mock/` on this branch (was `handoff/floating-kin/mock/`).
- Measurement scripts and results: `handoff/floating-kin/spike/` (was `handoff/floating-kin/spike/`).
- Screenshots: `handoff/floating-kin/mock/shots/` (transparent backgrounds).
- Not included on purpose: raw Claude stream logs, client-config backups, any
  credentials. Do not look for them.

## Goal

Build an opt-in, Desktop-owned floating Kin overlay that shows which AI Client
Conversations have recent captured activity and offers fixed buttons (no text
input) that produce a summary of the running turn, or wider Project context,
using the User's connected AI Client for synthesis.

The decision record is **ADR 0070** (Proposed), PR #546 (draft, ADR only):
`docs/adr/0070-floating-kin-recent-agent-work.md`. Read it first. Do not
contradict it without surfacing the conflict.

## Hard constraints

- No backend LLM calls (ADR 0001). Synthesis goes through the AI Client path.
- No managed-conversation execution, no "Continue in Koed" (ADR 0065 set aside).
  Do not revive them.
- Do not revive Chief of Staff naming/look customization (separate decision).
- Read-only: never send anything to, resume or interrupt the observed client.
- Overlay is a Desktop-owned window: disappears on Quit Desktop even if the
  runtime keeps running. Do not host it in a background process.
- Off by default. Never auto-start a stopped runtime, never override a durable
  Stop, never fall back to another AI Client.
- Use canonical terms from `CONTEXT.md`. "Kin" and "Chief of Staff" are not in
  the glossary yet; add terms (implementation-free) before user-facing copy.
- AGENTS.md rules apply: docs updates in `/docs` for flow changes, changeset
  confirmation with the user, Conventional Commit PR titles, scratch files in
  `scratch/`, run `pnpm fmt:check`, `pnpm lint`, relevant typecheck/build before
  pushing.

## Measured facts (one Claude Code run, small model, ~2.5 min turn)

- Raw items land in `conversation_items` 1.1-2.5s after transcript time (median
  ~1.5s): tool calls, results, agent messages, reasoning (`agent_reasoning`),
  user message.
- User message seals into a `memory_events` row after ~4s. The agent turn seals
  as ONE Memory Event only at turn completion (~168s later).
- Session-scoped Memory Answer mid-turn returned "insufficient" (no agent
  actions). After completion it was accurate with sources, ~17s.
- The model got the newest-activity time wrong: Koed must compute and display
  "as of" itself.
- Desktop's `conversation_events_changed` is driven by sealed events, so it does
  NOT fire per raw item.
- No API reads raw `conversation_items` for Desktop.
- Not yet measured: Codex, Pi, longer turns, larger models.

Consequence: running-turn summaries must read the raw timeline; Memory Answer
alone cannot do it.

## Code map (read, not modified)

- Desktop ask path: renderer `personal.ask.submit` IPC -> main
  `apps/desktop/src/koed-server/manager.ts` (`callLocalDesktopAsk`) reads
  `KOED_HOME/run/local-ai-runtime.json` (loopback, bearer, owner-only) and POSTs
  `/v1/desktop/ask`.
- Runtime route: `packages/mcp-server/src/local-runtime-server.ts`
  (`/v1/desktop/ask`, `answerAdmission`); executor
  `packages/mcp-server/src/memory-tool-executor.ts` (`executeDesktopAsk`,
  hard-coded `include_evidence:false`, `answer_only`, `origin:"desktop_ask"`).
  Only legacy `PersonalAskView` calls it; V1 UI does not mount it.
- Model resolution: `packages/mcp-server/src/ai-client-assignment.ts`
  (`mcp_memory_answer` assignment; defaults Claude `haiku`, Codex
  `gpt-5.6-luna`, Pi explicit; `resolveLocalMemoryAgentConfig` validates
  instance health, snapshot freshness, model/effort). Runtime aborts on
  `requestAbort.signal`.
- Reusable synthesis: `runAiClientJsonTask` in
  `packages/mcp-server/src/ai-client-runner.ts` (used by `session-title-worker.ts`
  and LCM workers). Prefer this for the new summary route.
- Recall Activity only lists `origin='mcp_memory_answer'`.
- Shared contract: `packages/shared/src/personal-desktop-contract.ts`.
- Desktop graph reads: `/v1/memory/graph/*`.
- Window/prefs: `apps/desktop/src/window/window-manager.ts`
  (`createMainWindowOptions`), `window/presentation-preferences.ts`
  (`graphicsAcceleration`, `showMenuBar`), `renderer/v1/settings-general.tsx`,
  launch-at-startup IPC pattern in `ipc/commands.ts` / `preload.cts`.
- Kin rendering: `apps/desktop/src/renderer/v1/pixelkin/stage.ts`
  (`createPixelkinActor`, `addPixelkin`, `setPixelkinExpression`, `hopPixelkin`,
  `wakePixelkins`, `projectKinLook(projectId, saved)`); schema
  `personalProjectKinSchema`; client logos in `onboarding/icons/`.
- Docs to update: `docs/personal-ask-and-notes.md`,
  `docs/managed-conversation-ai-client-routing.md` (read for context),
  plus a new/updated architecture doc for the overlay flow.

## Known engineering requirements

1. **Render loop:** the Pixelkin engine idles when the window is unfocused
   (`windowInactive`), which freezes an always-unfocused overlay. The mock works
   around it (`document.hasFocus = () => true`, wake on blur, 1s wake interval).
   The real implementation needs an overlay-specific render loop or engine flag,
   not that hack. Overlay must not steal focus.
2. **Privacy:** raw unsealed items must honor `memory_excluded_at` and any
   privacy filtering applied to sealed Memory. Unresolved; verify before
   exposing any raw item read.
3. **Change signal:** need an activity signal that reflects raw item arrival
   (poll or new event), since the sealed-event signal lags by a whole turn.
4. **Bounded work:** cancellation, time bound, and an "as of" timestamp computed
   by Koed; answer separates captured vs inferred; show sources.
5. **Chip cap/overflow** for many concurrent sessions, and an idle-vs-working
   duration cue (idle shows time since last activity).
6. **Accessibility/platform:** keyboard reachability, reduced motion, light/dark,
   screen-reader labels, macOS first (decision pending), always-on-top across
   Spaces, click-through for transparent areas.

## Suggested slice order (backend first)

1. **Read routes (owner-scoped):** list recently active Conversations (project,
   client, last-activity time) and a bounded recent raw-timeline slice for a
   Conversation, honoring exclusion/privacy. Tests alongside.
2. **Activity signal** for Desktop (raw-arrival based).
3. **Runtime summary route:** fixed actions (summarize current turn, project
   context) with templated prompts, using `runAiClientJsonTask`; returns summary,
   sources, Koed-computed as-of time; abortable; typed errors for runtime/client
   unavailable.
4. **Desktop main:** IPC + preference (off by default) + overlay BrowserWindow
   owned by main, closed on quit.
5. **Overlay renderer:** per-session chips using `projectKinLook(project)` plus
   AI client logo, pulsing dot, rounded pill, duration; summary panel; stopped /
   signed-out / quiet states.
6. **Verify on the live harness** with Claude Code, Codex and Pi runs; record
   Codex/Pi measurements back into ADR 0070 (and update it for the compact-chip
   design and render-loop finding, which it does not yet mention).
7. Docs, glossary terms, changeset recommendation (ask the user).

Open decisions that need the user before/while building: model assignment
(proposal: reuse `mcp_memory_answer`), retention of generated answers, how
"most recently active" is chosen with several sessions, global shortcut,
platform scope, whether Team extends this.

## Reference: the visual mock

`handoff/floating-kin/mock/` (throwaway, not production code):
`main.cjs` (Electron, transparent frameless always-on-top, bottom-right),
`entry.ts` (UI, bundled to `bundle.js` with
`../../../node_modules/.bin/esbuild entry.ts --bundle --format=iife --platform=browser --external:electron --outfile=bundle.js`),
`index.html`, `style.css`, `icons/`, `shots/` (PNGs). Run:
`cd handoff/floating-kin/mock && ../../../apps/desktop/node_modules/.bin/electron main.cjs`
(press `q` to quit). States: rest, idle, working, answer, project, stopped,
signedout, quiet. Design the user liked: pulsing dot, rounded pill, duration;
wants compact/dense chips combining per-project Kin and client logo.

## Environment (rebuild it; the original machine's stack is not available)

- Follow `AGENTS.md` / `README.md` Quickstart for a fresh bundled-local stack
  (`pnpm install`, `pnpm env:setup`, `pnpm build`, `runtime install`,
  `models install`, then start). If the stack refuses to start with "Source
  runtime artifacts do not match the current checkout", run
  `pnpm source-runtime:prepare`.
- Configure Claude Code and Codex as AI Clients; Pi is optional but needed for
  the Pi measurement. Find the bundled-local Postgres port in
  `~/.koed/config/local-ports.json` (it was 45432 on the author's machine, not
  15432).
- Measurement scripts read the DB password from `PGPASSWORD` in the
  environment; never print or commit it.
- The mock needs an Electron binary (use the one under `apps/desktop`
  node_modules) and esbuild to bundle `entry.ts`; the generated `bundle.js` is
  not committed. It also imports Pixelkin code from `apps/desktop/src/renderer/v1/pixelkin/`
  and icons, so run it from a checkout with those paths (set `userData` to a
  throwaway dir; it writes `.userData/`, which is not committed).
- To reproduce the timing measurement: run `handoff/floating-kin/spike/task-prompt.txt`
  as a headless Claude Code task with `observe.mjs` polling the DB, then `ma.mjs`
  for a mid-turn session-scoped Memory Answer. Raw output files are included
  (`observe.ndjson`, `ma-results.ndjson`) for comparison.

## Status

PR #546 is open as a draft containing only ADR 0070 (no code, no changeset).
No implementation has started.
