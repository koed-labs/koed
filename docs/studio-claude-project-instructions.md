# Claude Project instructions without Project settings

Status: implemented behind a default-off validation gate on 2026-10-15 under Ticket 04; not enabled for normal use. The User chose to preserve Koed's permission isolation and design instruction-only loading first. Two Luna Extra High follow-up reviews checked the provider and resource-reader boundaries. The earlier hosted, Move and live-review deferrals remain intact.

## Boundary

Read supported instruction text on the assigned execution computer and provide it to Claude as guidance. Keep Koed's selected permissions, tools, approvals and explicit MCP configuration authoritative. Do not enable a filesystem settings source to obtain instruction text, execute hooks, load plugins, or create another Memory path.

The installed Claude Agent SDK exposes `systemPrompt: { type: "preset", preset: "claude_code", append }`. The managed worker already uses this shape. It also explicitly selects `settingSources: []`. The SDK documents that enabling `project` loads Project settings as well as native `CLAUDE.md` context. A higher-priority settings object does not establish that every lower-priority permission rule is neutralized.

Use the existing Claude adapter and managed execution lifecycle. No new backend execution service, database migration, Agent instruction record, or browser-supplied instruction payload is needed.

## Bounded first implementation

The implementation follows this bounded contract, rather than claiming native Claude parity:

- Read only `CLAUDE.md` directly inside the selected registered Project root. Resolve the root from the execution's current verified local binding on its assigned device. Do not resolve a browser path, a Home label or a captured graph thread into a filesystem authority.
- Standalone Conversations do not inherit instructions from the standalone workspace's parent or the User's home. They retain the existing Koed guidance.
- Do not automatically discover ancestor, home, `CLAUDE.local.md`, `.claude/CLAUDE.md`, nested instruction or `.claude/rules` files in this initial contract. Do not expand `@path` imports. References in the text remain references; an AI Client may request ordinary file tools under the existing permission policy.
- Make this supported scope visible beside instruction-loading status. Do not label a root-file snapshot as all Project instructions loaded. Broader discovery requires a separate documented resolver contract and tests, rather than an accidental recursive directory scan.
- An absent root file is a normal no-instructions result. An existing unreadable, invalid or oversized file must produce a specific instruction-loading failure before provider submission; do not silently run a partially loaded instruction set. Preserve the User's draft and permit retry after correction.

Native Claude instruction behavior is broader: it includes ancestor and local files, conditional rules, nested discovery and recursive imports. This design intentionally does not reproduce those semantics. See Anthropic's [Project instruction documentation](https://code.claude.com/docs/en/memory).

## Local reader and limits

Add one small runner-local reader, with focused tests, beside the managed execution integration. Existing resource discovery returns skill/plugin metadata and cannot supply instruction text. Reuse established registered-Project and canonical-path validation; do not invoke resource discovery or a second SDK query to read a Markdown file.

The reader accepts one regular UTF-8 file, at most 64 KiB, with no silent truncation. Open with no-follow protection where supported, validate the opened file and its identity, and reject symlinks, non-regular files, invalid encoding and replacement during reading. Check canonical containment against the verified root, including intermediate path components. A preliminary `realpath` check alone is not a sufficient read boundary. Keep the read bounded even if the file changes after its initial size check.

Keep content and absolute paths local. Record a version, relative filename and content digest in a private instruction snapshot associated with the existing native session; use the existing managed-home ownership and recovery conventions. Do not publish instruction bytes in capability snapshots, Team activity or hosted launch responses. Do not write them into Agent metadata or Memory as a synthetic User message.

## Delivery, continuation and recovery

At new-session creation, append a clearly labelled instruction block to the existing Claude Code preset, retaining the existing Koed guidance. Describe the block as Project guidance that cannot change tool permissions. Pass its text through `systemPrompt.append`, not the public User prompt or the shared Agent-context transfer text. This places the text in a system-prompt extension rather than Claude's native Project-context channel; do not describe the two as identical or let the text confer executable authority. The selected model, effort, approval callback, explicit tools and MCP configuration remain unchanged.

The implementation freezes the instruction snapshot for that native session. Reopening or restarting reuses the same verified snapshot; it does not silently reload different disk contents into the same history. Edits apply to a new Conversation until an explicit instruction-refresh operation has its own verified SDK behavior. Existing Conversations without a snapshot must not be silently presented as having newly loaded instructions.

This is an enablement gate: the pinned SDK supports `append` and `resume`, but its type contract does not prove that a changed system prompt reaches an already recorded session. Current upstream documentation describes newer prompt recording and refresh behavior. Do not assume it applies to Koed's pinned SDK or executable, or invent an unsupported option. Verify initial delivery, continuation and restart against the supported executable versions before enabling. See Anthropic's [system-prompt documentation](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts).

If the private snapshot cannot be recovered, do not silently substitute current disk contents. Report the recoverable instruction-context problem without changing the Conversation's Project, provider history or Memory attribution. Claude Project Move remains unavailable pending its existing provider-specific verification; this design does not authorize it.

## Selected skills

The current Claude adapter switches to `settingSources: ["user", "project"]` when selected skills are present. Therefore ordinary-chat isolation is not evidence of isolation for that branch.

Before general enablement, verify whether the pinned SDK's explicit `skills` option can execute the selected, validated skills without enabling filesystem settings. Keep resource selection and freshness validation. If this is unsupported, retain the feature gate and record the limitation under Ticket 22; do not silently discard selected skills, import Project permissions, or advertise instruction-only isolation for those turns. Discovery itself currently uses broader settings sources and needs separate review under Ticket 22; this document does not certify its isolation.

## Validation before enablement

1. Reader tests: absent and valid files; exact registered-root selection; standalone exclusion; invalid UTF-8; size and bounded-read limits; symlinks, non-regular files and file replacement; no parent/home/nested/rule/import discovery.
2. Adapter tests: supported text reaches `systemPrompt.append`; public prompt and response identity remain intact; `settingSources: []`, selected permissions, tool lists, approval callback and strict explicit MCP configuration remain controlled by Koed. Malicious or permissive Project settings and hook fixtures must not change them. Exercise selected skills separately.
3. Recovery tests: immutable snapshot reuse; missing/corrupt snapshot failure; no silent refresh; no duplicate public messages or new Memory ingestion path; independent provider snapshots in a multi-Agent Conversation.
4. Disposable live Claude checks: new Project chat reads an instruction marker, standalone does not; continuation and process restart retain the same instruction snapshot and native history; changed files do not silently change it; selected permissions still govern real tool use. Record SDK and executable versions. Hosted/two-device and Claude Move acceptance stay deferred.

## Implementation checkpoint

The worker now integrates the root-file reader with fresh ordinary Claude starts and same-home recovery. It stores snapshots under the managed home's private `.koed/claude-project-instructions` directory. A signed managed-home marker records that a snapshot is required independently of that directory, so deleting the directory cannot make the session appear legacy. Marker verification and the expectation survive retain, lease release and reuse. Existing unmarked sessions are not retrofitted.

`KOED_CLAUDE_PROJECT_INSTRUCTIONS=1` opts fresh starts into the validation path; the default is off. Disabling the flag later does not remove the requirement to recover an already marked session's snapshot. This is a contributor validation gate, not a claim of production acceptance. No running service configuration was changed.

Opted-in turns keep filesystem settings disabled and reject selected skills before SDK submission with an explicit error. This preserves instruction-only isolation without claiming unverified skill execution. Safe root-only status uses the existing progress path; local and hosted chat views translate the new failure codes into readable messages. No instruction bytes or local paths are put in those status/error messages.

Fork and handoff reconstruct a different managed home without carrying the private snapshot. Authority guards now reject owner-matched numeric snapshot markers before queuing fork/handoff commands or changing source state. They reuse captured-session metadata for a content-free version flag; no new schema or instruction text is stored there. Source-side signed-marker checks also reject marked sessions before sealing or publishing transfer material. Instruction-enabled sessions intentionally do not support fork/device transfer; snapshot transport is not claimed. General enablement still awaits the live Claude gate. Do not treat the validation flag as support for transferring instruction-enabled sessions. This limitation does not reopen deferred Claude Project Move or hosted acceptance.

Run the disposable provider validation after building MCP Server and worker:

```sh
pnpm --filter @koed/mcp-server build
pnpm --filter @koed/worker build
KOED_CLAUDE_SMOKE_MODEL=<available-model> node scripts/claude-project-instructions-smoke.mjs
```

The script uses a temporary Project and Koed home, existing Claude sign-in, and separate processes for first execution and resume. It does not use a live database or copy credentials. It checks root guidance, history, frozen instructions after disk edits, real tool denial, settings/hook isolation and pre-submission selected-skill refusal; standalone exclusion is checked with a separate native session in an independent workspace, with a parent instruction marker present. Provider text and local paths are not printed. On this host it exited with `BLOCKED` (code 2): no supported signed-in Claude Code executable was available, and no provider query ran. This is not a live pass.

The approved existing minor changeset describes this gated implementation. Ticket 04 remains open and the distinct open-ticket count stays 12.

Validation checkpoint: the focused API/runner/reader/adapter suite passed 251 tests, Studio launch/component and client/sidebar/preference suites passed, and three authority regressions passed against a new disposable PostgreSQL database migrated through this branch's schema. That database was removed. No configured Personal database was migrated. MCP Server and worker builds and Studio typecheck passed. Scoped lint passes for new code and UI; the worker service and DB test file report lint findings on unchanged lines. The worker-service findings were reproduced on the clean HEAD source. The live provider script remains blocked, not passed.

Final focused results: 251 API/runner/reader/adapter tests, 31 Studio launch/component tests, 42 client/sidebar/preference tests and three disposable PostgreSQL authority tests passed (327 total). The authority checks include idempotent replay, foreign-owner isolation and numeric-versus-string marker behavior. Changed-file formatting and diff checks passed; MCP Server, DB and worker builds, Studio typecheck, new-code/UI lint and release consistency passed. Full worker-service lint retains five findings reproduced in the HEAD baseline (six there); the broader DB test-file lint has three findings on unchanged lines and was not baselined separately. These limits are not advertised as full-repository green.
