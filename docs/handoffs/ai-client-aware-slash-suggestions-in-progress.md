# Handoff: AI Client-Aware Slash Suggestions

Status: Phases 1-5 implemented; validation is recorded in the Phase 4-5 handoff.

Base commit: `ff5c7e1 feat(pds): secure capability-based personal device enrollment (#399)`
Current branch: `feat/ai-client-aware-slash-suggestions`
Implementation remains uncommitted on this branch.

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

### Phase 4: Adapter Implementation (COMPLETE)

The API route now calls the Worker adapter after owner, capability, and local
Project-root validation. Discovery supports Codex prompt files, Claude commands
and skills, and Pi prompt files and skills. Definitions are scoped as global or
Project; Project definitions take precedence on same-kind/name collisions.

The request carries an optional Koed Project ID, not a renderer-supplied cwd.
The API resolves that ID through local Project metadata before passing the
verified root to the adapter. Project-free Chats therefore discover global
commands without inventing a Project scope. Adapters bound file sizes and
directory traversal, reject symlinks escaping allowed roots, sanitize returned
metadata, and fail closed on errors or timeout. Command suggestions do not
execute provider commands.

### Phase 5: Tests and Docs (COMPLETE)

Tests cover global discovery without a Project, Project/global precedence,
Claude commands and skills, Pi prompts and skills, symlink escape rejection,
protocol validation, preload wiring, hook caching/fail-closed behavior, and
ConversationInput suggestions.

`docs/managed-conversation-ai-client-routing.md` documents the routing path,
supported file roots, scope rules, safety boundaries, and cache behavior.

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

## Validation at handoff

- Worker adapter tests: 6 passed.
- API managed-conversation route tests: 42 passed.
- Desktop targeted protocol, hook, suggestion, input, Ask, and Project tests passed.
- API and Desktop typechecks passed.
