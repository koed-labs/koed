# Handoff: Pi runtime command discovery and model catalog verification

## Request and branch

Continue on `feat/ai-client-aware-slash-suggestions`. The Operator requested that
pending local fixes be committed and pushed with this handoff, rather than
implementing the remaining Pi work in this session. PR creation remains paused.
Do not treat this branch as complete or merge-ready.

The branch was fast-forwarded to `origin/feat/command-op-id-persistence`
(`fa26e027`), which contains the earlier slash-suggestion stack. The next commit
contains the fixes below and this handoff. No history rewrite is needed.

## Completed fixes

- Codex draft discovery now parses the real `skills/list` response:
  `data[].skills`, not `data[]` as individual skills. Disabled and repo-scoped
  entries are excluded from global draft discovery. Use the selected instance's
  `MEMORY_CODEX_APP_SERVER_BINARY`, not an unrelated executable setting.
- Claude draft discovery now delegates to the bounded, selected-instance file
  adapter. It no longer reads the API process cwd or ignores `CLAUDE_CONFIG_DIR`.
  This is a safe fallback, **not** a claim of live Claude discovery parity.
- Empty/loading/error slash states render even when there are no options.
- Popup positioning is anchored to the composer. Its height is bounded and
  scrollable, with an opaque themed background. Previously Electron received
  39 commands but the popup's top was -933px and it was clipped by main content.
- Keyboard selection scrolls into view without transferring textarea focus.
- Before launch options arrive, the client picker says “Loading AI Clients…”
  instead of claiming the client is unavailable.
- Regression tests and a real Electron CDP visibility/navigation harness were
  added. Routing documentation describes current behavior and limitations.

## Remaining user-visible issues

1. Selecting Pi and typing `/` shows “No matching commands.” Installed Pi skills
   include packages and external symlinks which the current bounded file scan
   deliberately does not traverse. Do **not** solve this by loosening filesystem
   confinement or fabricating commands. Runtime discovery is the requested fix.
2. The Operator suspects Pi's model picker is stale because it displays models
   such as `gpt-5.3-codex-spark`, `gpt-5.6-luna`, and `gpt-6-luna`. This has **not**
   been confirmed. Pi can legitimately offer those models through authenticated
   providers. Compare selected-instance launch options with Pi's native
   `get_available_models` response before changing anything.
3. Settings can say “Not set up” while Codex Managed Conversation is ready. The
   label reflects integration configuration, not proof command discovery is
   unavailable. Do not require capture/recall setup to repair a popup bug.
   Earlier Electron API probes returned Codex `ok`/39 commands and Claude/Pi
   `unauthorized`; later the Operator enabled/selected Pi. Refresh current state
   rather than assuming the earlier authorization result still applies.

## Desired direction: runtime-owned discovery

The Operator explicitly wants Pi commands discovered from the selected runtime,
like Codex's provider-backed discovery, not merely from Markdown scanning.
For an active Conversation, use the owning Pi runtime and preserve instance,
execution-generation, cwd, authorization, and capability boundaries.
For a draft, inspect a properly scoped runtime initialized with the selected
instance's executable/configuration and real resource loading. A no-Project Chat
must not accidentally inherit repository resources from the API cwd. Bound
initialization and cleanup; do not submit a prompt, invoke commands, create a
managed Conversation, or call an LLM just to discover metadata. Loading trusted
extensions can itself have side effects: use the established runtime policy,
not arbitrary plugin code execution introduced through an API request.

### Confirmed native Pi protocol

The installed Pi package documents:

```json
{ "id": "discover-1", "type": "get_commands" }
```

Response is `type: "response"`, `command: "get_commands"`, `success: true`,
`data.commands` containing:

- `name` (exact invocation name, no leading slash)
- optional `description`
- `source`: `extension`, `prompt`, or `skill`
- `sourceInfo`: resource path/source, `scope` (`user`, `project`, `temporary`),
  origin (`top-level`, `package`), and optional package base directory

**Skills are named `skill:<name>`**, so insertion must preserve `/skill:<name>`.
Current catalog validators assume alphanumeric/slash names and may reject the
colon. Audit protocol parsers, UI helpers, and invocation parsing rather than
silently stripping it. Extension commands use runtime invocation names.
Built-in TUI-only commands such as `/settings` and `/hotkeys` are deliberately
absent; do not guess or advertise them as invokable RPC commands.
The `prompt` RPC accepts extension commands and expands skills/templates, but
listing and selecting must never execute them. Inspect prompt acknowledgements:
`disposition: "handled"` need not start an LLM run.

`get_available_models` returns `data.models` from the same native runtime.
Compare provider-qualified identities, not only display names, and preserve
model/reasoning compatibility when switching instances.

Primary references on this machine (read docs for the installed version):

- Pi installation: `/Users/jedd/.local/share/fnm/node-versions/v24.14.0/installation/lib/node_modules/@earendil-works/pi-coding-agent/`
- `docs/rpc.md`, `docs/rpc-commands.md` (`get_commands`, `get_available_models`,
  `prompt`), `docs/sdk.md`
- `dist/modes/rpc/rpc-types.d.ts`, `dist/modes/rpc/rpc-mode.js`, and exported
  `RpcClient` implementation. Avoid dumping `.js.map` files into tool output.

Read relevant Pi docs fully and follow applicable references before implementing.
Koed currently has native SDK/RPC integration; inspect the actual configured
installation and supported contract rather than assuming this package path
applies to every instance.

### ACP

ACP could be an optional standardization path where a provider adapter supports
command-list session updates. It does not automatically expose Pi resources to
Koed. No ACP integration was implemented or validated here. The direct native
`get_commands` seam already exists, so prefer it for this focused repair; a new
ACP transport would be broader architectural work requiring separate review.

## Code entry points

- `packages/mcp-server/src/pi-managed-conversation.ts`: `listCommands()` currently
  performs file scanning; replace/route to runtime-owned native discovery.
- `packages/mcp-server/src/pi-rpc-runner.ts`: established RPC transport, model
  probing (`get_available_models`), timeout and process lifecycle patterns.
- `apps/worker/src/command-discovery-adapter-pi.ts`: currently only file fallback.
- `apps/worker/src/command-discovery-adapter.ts`: filesystem roots and confinement.
- `apps/worker/src/managed-conversation-provider-runtime.ts`: owner dispatch seam.
- `apps/api/src/managed-conversations/routes.ts`: command discovery authorization;
  draft provider branch currently handles Codex/Claude, not native Pi discovery.
- `apps/desktop/src/ipc/managed-conversation-protocol.ts`: name validation and
  transport contract.
- `apps/desktop/src/renderer/views/personal/use-slash-command-discovery.ts`:
  currently requests `mode: "draft"` even for consumers in active Conversations;
  audit scope/owner identity before routing live discovery.
- `ConversationSettings.tsx`, `PersonalAskView.tsx`: selected-instance model
  catalog and initial launch-option loading.
- `ConversationInput.tsx`, `SlashCommandMenu.tsx`,
  `ai-client-slash-suggestions.ts`: exact insertion, filtering and keyboard state.

Also inspect Enter/Tab command selection: current key handler consumes these
keys while autocomplete is open but has no corresponding selection branch.
This was not fixed or end-to-end validated in the present work. Add a true
keyboard-selection test, not a component-accepts-props-only assertion.

## Validation at handoff

- `pnpm typecheck`: passed.
- `pnpm --filter @koed/desktop build`: passed after the final UI changes.
- Targeted suite: **9 files, 72 tests passed**:

```sh
pnpm exec vitest run \
  apps/worker/src/command-discovery-adapter{,-codex,-claude,-pi}.test.ts \
  apps/desktop/src/renderer/views/personal/{ConversationSettings,SlashCommandMenu,ConversationInput,ai-client-slash-suggestions,use-slash-command-discovery}.test.*
```

- Targeted formatting/lint of this session's touched files passed. Re-run after
  reading this handoff; full branch validation is not clean.
- `pnpm fmt:prettier:check`: fails on existing branch MCP/protocol files and local
  ignored `.pi/todos` files. Do not format unrelated local task files.
- `pnpm lint`: **18 errors** remain in existing MCP managed-conversation and
  operation-ID-store sources/tests (unused bindings, require-await, escapes,
  unresolved unsafe test types). These predate this session's fixes.
- Earlier broader tests found Pi resume assertions and API command provenance
  expectations failing, plus Desktop protocol/preload suites failing root-run
  module resolution for the new MCP subpath. Those have not been repaired.
- Existing minor product changeset:
  `.changeset/bright-lions-suggest-commands.md`. It was preserved unchanged.
  No additional release decision was made; confirm changeset policy with the
  Operator before adding/omitting release notes for the next work.

### Real Electron feedback loop

With the **new Chat screen**, Codex selected, and an empty draft, launch a local
test instance with localhost-only CDP:

```sh
KOED_DEPENDENCY_MODE=bundled-local pnpm --dir apps/desktop exec electron . \
  --remote-debugging-port=9223 --remote-debugging-address=127.0.0.1
node apps/desktop/scripts/validate-slash-suggestions.mjs
```

Last actual result:

```json
{
  "ok": true,
  "count": 39,
  "visible": true,
  "background": "rgb(255, 255, 255)",
  "selectedVisible": true,
  "focusRetained": true,
  "scrolled": true
}
```

The harness types `/` without submitting and moves down 20 rows. It refuses to
replace a nonempty draft other than `/`. It leaves that test draft/menu in place.
Extend it for Pi discovery after native routing is implemented. Close the debug
instance and restart without the debugging port afterward. The last app launched
in this session was running normally without CDP. Local validation logs live in
`/tmp/koed-slash-validation/` and are not committed or guaranteed persistent.

## Acceptance for the next agent

- Native selected-instance Pi discovery returns package/extension/template/skill
  metadata that the same runtime can invoke, with exact names and provenance.
- New Chat global scope and verified Project scope are distinct; active owner
  discovery is fenced and cannot read another instance/Conversation.
- Unsupported/unavailable runtime discovery is explicitly distinguished from
  an empty query result; no guessed built-ins and no weakened file confinement.
- Model picker freshness is verified against native selected-instance data, with
  a regression test if a stale-state bug is reproduced.
- Selecting a suggestion only inserts; keyboard Enter/Tab work without sending.
- Pi Electron end-to-end validation passes; full branch lint/format/test failures
  are addressed or clearly reported before opening a merge-ready PR.
- Update `/docs` for integration flow changes. Keep `CONTEXT.md` implementation-free.
- Confirm release-note scope with the Operator. Open the complete slash-work PR
  only when explicitly resumed; use `.github/pull_request_template.md`.
