# Handoff: AI Client-Aware Slash Suggestions

Status: Planning handoff. No implementation started.

Base branch: `main`
Base commit: `ff5c7e1 feat(pds): secure capability-based personal device enrollment (#399)`

## Goal

Bring AI Client-aware slash command and skill suggestions into Koed's managed
Conversation input. Suggestions must come from the selected AI Client instance,
not from a global hard-coded list or another instance.

Initial scope is discovery, autocomplete, insertion, and safe fallback. Do not
implement binary attachments, arbitrary file uploads, or plugin attachment
sources in this slice.

## Product behavior

- Typing `/` at the start of input opens a command menu.
- Typing `/query` filters commands and skills.
- Suggestions show command name, description, and optional argument hint.
- Keyboard navigation supports ArrowUp, ArrowDown, Enter, Tab, and Escape.
- Selecting a provider command inserts `/<name> `; it does not submit it.
- Existing text and cursor position remain intact for inline slash commands.
- Slash handling remains safe with IME composition and multiline text.
- Commands are refreshed when selected AI Client instance or Conversation
  runtime changes.
- Loading, stale, unavailable, and empty states are explicit and non-blocking.
- Unsupported or stale command names remain ordinary prompt text; no silent
  command execution.
- Client-side commands, if later added, must be modeled separately from
  provider commands. This handoff targets provider-discovered commands only.

Use Koed terminology: AI Client, User, Conversation, Project, and Project
context. Do not describe this as backend answer synthesis or Memory behavior.

## Current Koed surfaces

Shared input:

- `apps/desktop/src/renderer/views/personal/ConversationInput.tsx`
  - Shared by new and active managed Conversations.
  - Owns textarea, Enter handling, IME guards, settings, and send button.
  - Currently accepts only `value`, `onChange`, and `onSubmit`.
  - Needs cursor/selection-aware autocomplete hooks and key handling.

New Conversation:

- `apps/desktop/src/renderer/views/personal/NewConversationComposer.tsx`
  - Starts selected AI Client instance and sends optional first prompt.
  - Has launch `options`, `selection`, and selected instance context.
  - Slash suggestions may use selected instance capabilities before start only
    if command discovery is available. Otherwise keep MVP active-Conversation
    only and document new-Conversation limitation.

Active Conversation:

- `apps/desktop/src/renderer/views/personal/PersonalMemoryViews.tsx`
  - `ManagedConversationComposer` owns draft and submit lifecycle.
  - Resolved Conversation has execution, captured-session, thread, driver, and
    instance identity.
  - Existing context attachments are file-operation and terminal references;
    they are not binary prompt attachments.
  - Submission has idempotency and uncertain-delivery recovery. Do not alter
    those semantics for autocomplete.

IPC:

- `apps/desktop/src/ipc/managed-conversation-protocol.ts`
  - `ManagedConversationSendRequest` carries prompt, file mention command IDs,
    terminal context references, and optional settings change.
  - Targets/options currently expose instances, models, and permission
    capabilities, but no slash command list.
  - Add typed command discovery only after deciding request freshness and
    execution identity rules.

API:

- `apps/api/src/managed-conversations/routes.ts`
  - `launchInstances()` returns selected AI Client instances and capability
    state.
  - `assertManagedCapability()` validates enabled instance, driver match,
    config identity, authentication, health, expiry, and descriptor readiness.
  - Prompt schema and send route currently do not need changes for insertion-only
    provider commands.

Worker/native adapters:

- `apps/worker/src/managed-conversation-service.ts`
  - Owns managed runtime dispatch and provider-specific behavior.
  - Provider command discovery must use the same selected driver/instance and
    runtime authority as prompt dispatch.
  - Do not infer one provider's command protocol for another provider.

Documentation:

- `docs/managed-conversation-ai-client-routing.md`
  - Canonical routing, capability, adapter, and Conversation identity rules.
  - Update only after contract and behavior are implemented.

## Paseo patterns worth adapting

Reference repository reviewed at commit
`43a2a7969cbf049455b998d38ccd18ce179a88d1`.

Useful patterns:

- `packages/app/src/hooks/use-agent-autocomplete.ts`: derives active slash
  range from text and cursor, queries provider commands, maps options, and
  handles keyboard selection.
- `packages/app/src/utils/agent-command-autocomplete.ts`: isolated helpers for
  finding slash ranges, filtering/ranking commands, and replacing selected
  command text.
- `packages/app/src/composer/input/input.tsx`: preserves normal Enter behavior
  while giving autocomplete first chance to consume navigation keys.

Do not copy Paseo's client/plugin command system wholesale. Koed's AI Client
selection, capability snapshots, and managed execution identity are different.

## Recommended implementation phases

### Phase 1: Pure autocomplete helpers

Add small, tested helpers under the Desktop renderer:

- `findActiveSlashCommand({ text, cursorIndex })`
- `filterSlashCommands(commands, query)`
- `applySlashCommandReplacement({ text, range, commandName })`
- command type with `name`, `description`, optional `argumentHint`, and
  provider/skill kind

Rules:

- Slash must be at input start or preceded by whitespace.
- Query cannot cross whitespace, quote, newline, or another slash.
- Cursor may be in middle of text.
- Replacement preserves text after cursor and appends one space only when
  replacement reaches end of input.
- Keep functions pure and under 50 lines.

### Phase 2: Input UI

Extend `ConversationInput` with optional autocomplete props rather than binding
it directly to API state. Add:

- `autocompleteOptions`
- `autocompleteLoading`
- `autocompleteError`
- `onAutocompleteSelect`
- `onAutocompleteKeyDown` or an imperative key handler
- cursor/selection reporting

Render accessible popover/listbox near input. Ensure:

- autocomplete receives key events before submit handling;
- Enter submits only when menu did not consume it;
- Escape closes menu before any broader Conversation behavior;
- composition events never open or select commands incorrectly;
- disabled/busy input cannot select commands.

Keep popup rendering lightweight. Avoid recreating option objects and callbacks
on every keystroke where practical.

### Phase 3: Command discovery contract

Choose one contract before wiring UI. Preferred shape:

```ts
type ManagedConversationSlashCommand = {
  name: string;
  description: string;
  argumentHint?: string;
  kind: "command" | "skill";
  source: "provider";
};
```

Discovery must be scoped by:

- `aiClientDriverId`
- `aiClientInstanceId`
- current Project/cwd where provider requires it
- execution identity when Conversation is active

Define timeout, stale result, and unavailable behavior. A discovery response
must not mutate Conversation state or start an AI Client turn.

Possible transport options, in preferred order:

1. Add a read-only managed Conversation command-discovery operation backed by
   the active runtime, with server-side instance/capability checks.
2. Include a bounded command snapshot in runtime/inspection responses if native
   adapters already have a trustworthy cached list.
3. Do not scrape transcript output or run arbitrary shell commands from Desktop.

The API must reject a request for a different User, instance, driver, or
execution generation. Discovery is diagnostic/read-only and must not require a
prompt idempotency key.

### Phase 4: Adapter implementation

Implement provider-specific discovery behind a provider-neutral interface.
Validate actual support per adapter:

- Codex: use its available command/skill discovery path.
- Claude Code: preserve distinction between root commands and skills where
  adapter can identify it.
- Pi: inspect current SDK/runtime capabilities before exposing commands.

If adapter cannot discover commands reliably, return an empty list with a
non-fatal diagnostic. Do not advertise guessed commands.

### Phase 5: Tests and docs

Required tests:

- slash range at start, inline, cursor middle, and invalid boundaries;
- filtering, stable ordering, empty query, and duplicate names;
- replacement with trailing text and cursor placement;
- Arrow/Tab/Enter/Escape behavior;
- IME composition and Shift+Enter behavior;
- new versus active Conversation instance identity;
- stale discovery response after instance switch;
- unavailable capability and timeout states;
- provider adapter command normalization;
- API authorization and execution-generation boundaries;
- no prompt submission caused by selecting a suggestion.

Run targeted Desktop/API/Worker tests, typecheck, and formatting. Update
`docs/managed-conversation-ai-client-routing.md` and relevant Desktop UI docs
with final contract and provider limitations. No changes to `CONTEXT.md` are
expected.

## Non-goals

- Binary image/file prompt attachments.
- Clipboard image paste or drag/drop upload.
- Paseo plugin system.
- Arbitrary local path injection.
- Server-side LLM synthesis.
- Automatic execution of slash commands from the suggestion menu.
- Changing Conversation capture, Memory, Projection, or Recall semantics.

## Handoff completion criteria

A follow-up agent is done when a User can select an AI Client instance, type `/`,
see only commands discovered for that instance, select one without accidental
submission, and send it as ordinary provider-recognized prompt text. Stale,
unsupported, unauthorized, or unavailable discovery must fail closed and leave
prompt submission behavior unchanged.
