# Handoff: AI Client-Aware Slash Suggestions (In Progress)

Status: Phases 1-3 complete, Phase 4-5 remaining

Base commit: `ff5c7e1 feat(pds): secure capability-based personal device enrollment (#399)`
Current branch: `feat/ai-client-aware-slash-suggestions`
Current HEAD: `8d95713 feat(worker): add command discovery adapter interface and factory (stubbed)`

See also: [Phase 4-5 Handoff](./ai-client-aware-slash-suggestions-phase4-5.md)

## What's Done

### Phase 1: Pure Autocomplete Helpers ✅
**Files:**
- `apps/desktop/src/renderer/views/personal/ai-client-slash-suggestions.ts` — 4 pure functions
- `apps/desktop/src/renderer/views/personal/ai-client-slash-suggestions.test.ts` — 33 tests

**Contracts:**
```ts
type ManagedConversationSlashCommand = {
  name: string;
  description: string;
  argumentHint?: string;
  kind: "command" | "skill";
  source: "provider";
};

type SlashCommandRange = { start: number; end: number };
type ActiveSlashCommand = { query: string; range: SlashCommandRange };
```

**Functions:**
- `findActiveSlashCommand({ text, cursorIndex })` → `ActiveSlashCommand | null`
  - Range covers query text only (after slash, not including slash)
  - Slash must be at input start or after whitespace (`\s\n\t`)
  - Rejects if quote (`"'`/`` ` ``) appears between slash and cursor
  - Query cannot cross whitespace, quote, newline, or another slash
- `filterSlashCommands(commands, query)` → `ManagedConversationSlashCommand[]`
  - Case-insensitive match on name and description
  - Preserves original order; empty query returns all
- `applySlashCommandReplacement({ text, range, commandName })` → `string`
  - Replaces query portion only; preserves surrounding text and slash
  - Appends trailing space only when replacement reaches end of input
- `slashCommandKeypressIsHandled({ key, open, isComposing, disabled })` → `boolean`
  - Returns true for ArrowDown, ArrowUp, Tab, Escape, Enter (when open)
  - Enter blocked during IME composition

### Phase 2: Input UI Integration ✅
**Files:**
- `apps/desktop/src/renderer/views/personal/ConversationInput.tsx` — extended with autocomplete
- `apps/desktop/src/renderer/views/personal/ConversationInput.test.tsx` — 8 tests
- `apps/desktop/src/renderer/views/personal/SlashCommandMenu.tsx` — popover component
- `apps/desktop/src/renderer/views/personal/use-slash-command-autocomplete.ts` — hook (unexported; logic is inline in ConversationInput)
- `apps/desktop/src/renderer/views/personal/conversation-settings.css` — added `.ai-suggestion-*` styles

**Changes to ConversationInput:**
- New optional props: `autocompleteOptions`, `autocompleteLoading`, `autocompleteError`, `onAutocompleteSelect`
- Internal state: `autocompleteOpen`, `selectedIndex`, `filteredCommands`
- `handleKeyDown` — autocomplete keys have priority; Escape always prevents default; Enter falls through to submit when menu closed
- `handleInputChange` — `findActiveSlashCommand` on each keystroke; opens menu when slash detected; filters against `autocompleteOptions`
- Renders `<SlashCommandMenu>` inside `.ai-suggestion-popover` when open and filtered commands exist
- Menu items: listbox with `role="option"`, `aria-selected`, hover highlight via `.ai-suggestion-item-selected`

## What's Done

### Phase 3: Command Discovery Contract ✅

**All infrastructure wired end-to-end:**
- IPC protocol: `command_discovery` operation with request/result types and parsers
- Desktop preload: `discoverCommands()` API method
- Koed Server manager: `command_discovery` handler routing
- API route: `POST /v1/managed-conversations/commands` with full scope validation
- Desktop hook: `useSlashCommandDiscovery()` with debounce, stale-if-error, keyed cache
- UI integration: ConversationInput wired to hook output via autocomplete props
- Worker adapter: interface + factory (stubbed per driver)
- Tests: protocol parser tests, preload tests, hook tests

See [Phase 4-5 Handoff](./ai-client-aware-slash-suggestions-phase4-5.md) for remaining work.

**Goal:** Wire provider-discovered commands into the UI via a typed protocol.

**Decisions to make before implementing:**
1. Which transport? Preferred order:
   - (a) Read-only managed Conversation command-discovery operation backed by active runtime
   - (b) Bounded command snapshot in runtime/inspection responses
   - (c) Do NOT scrape transcript or run arbitrary shell commands

2. Request freshness and execution identity rules:
   - Must be scoped by `aiClientDriverId`, `aiClientInstanceId`, Project/cwd, execution identity
   - API must reject request for different User/instance/driver/execution generation
   - Discovery is diagnostic/read-only; must not mutate Conversation state or start a turn
   - No prompt idempotency key needed

**Files to modify:**
- `apps/desktop/src/ipc/managed-conversation-protocol.ts` — add discovery request/response types
- `apps/api/src/managed-conversations/routes.ts` — add discovery route
- `apps/desktop/src/renderer/state/use-managed-conversation-lifecycle.ts` — hook for discovery fetch
- New Conversation composer also needs discovery (pre-start) — document limitation if not available

**Key rules:**
- Timeout handling, stale result caching, unavailable state
- Discovery response must not affect prompt submission behavior
- Stale discovery after instance switch must fail closed

### Phase 4: Adapter Implementation (REMAINING)

**Goal:** Wire provider-specific command discovery into the API route.

**Current state:** API route validates scope and capability, then returns `{ status: "ok", commands: [] }` — a hardcoded stub.

**Required changes:**
1. Wire API route to call `createCommandDiscoveryAdapter()` per driverId
2. Implement per-adapter discovery:
   - **Codex:** inspect active process's registered slash commands
   - **Claude:** read root commands and skills from SDK session state
   - **Pi:** inspect SDK/runtime capabilities
3. Handle adapter errors → return `{ status: "unavailable", commands: [] }`
4. Command field validation (name ≤64 chars, description ≤512 chars)

See [Phase 4-5 Handoff](./ai-client-aware-slash-suggestions-phase4-5.md) for detailed implementation.

### Phase 5: Tests and Docs (REMAINING)

**Required tests (not yet written):**
- API route adapter integration tests
- Per-adapter factory and implementation tests
- Wire integration tests (discovery fetch, menu populates, instance switch invalidates)
- Adapter timeout handling
- Command field validation tests

**Docs to update:**
- `docs/managed-conversation-ai-client-routing.md` — add command discovery contract section
- This handoff — mark all phases complete

**Non-goals (unchanged):**
- Binary image/file prompt attachments
- Clipboard image paste or drag/drop upload
- Paseo plugin system
- Arbitrary local path injection
- Server-side LLM synthesis
- Automatic execution of slash commands from suggestion menu
- Changing Conversation capture, Memory, Projection, or Recall semantics

## Handoff Completion Criteria

A follow-up agent is done when a User can:
1. Select an AI Client instance
2. Type `/` and see only commands discovered for that instance
3. Select a command without accidental submission
4. Send it as ordinary provider-recognized prompt text
5. Stale, unsupported, unauthorized, or unavailable discovery fails closed and leaves prompt submission behavior unchanged

## Notes for Next Agent

- The `use-slash-command-autocomplete.ts` hook was created but the logic ended up inline in `ConversationInput.tsx` instead (simpler wiring, avoids exporting a complex hook). The hook file exists but is not currently exported or used — it can be removed or refactored.
- The CSS uses design tokens (`--muted-foreground`, `--accent-background`, etc.) — verify these exist in the project's CSS variables.
- All tests pass: `pnpm vitest run apps/desktop/src/renderer/views/personal/ai-client-slash-suggestions.test.ts` (33 tests) and `pnpm vitest run apps/desktop/src/renderer/views/personal/ConversationInput.test.tsx` (8 tests).
- For Phase 3, read `docs/managed-conversation-ai-client-routing.md` before modifying the protocol.
- The original handoff spec is at `docs/handoffs/ai-client-aware-slash-suggestions.md`.
