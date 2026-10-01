# Implementation backlog

## Studio Personal Agents

Plan: [persistent identities, conversation participation and runtime context](docs/studio-personal-agents-plan.md).

- Completed: map original Agents UI and existing backend contracts before implementation.
- Completed: persist owner-scoped identities, encrypted soul versions, model defaults and retirement.
- Completed: reuse the original Agents design; add default model/effort and editable instructions.
- Completed: role-template catalogue with Git-managed source, immutable database publication, Role autosuggest and explicit editable-copy selection. Activated locally on September 23; existing agents are not updated automatically.
- Completed for Personal standalone New Chat: durable conversation participants, `@Agent` mentions, active respondent, actual model/effort defaults and attributable outputs.
- Completed: live New Chat selects Project IDs from the authorized Home snapshot and passes the selected Project to managed execution. Still add a complete Project catalogue and Project-instruction context before calling Project chat complete.
- Remaining: make the shared `@Agent` contract work in every chat mechanism. PR Chat needs a PR-specific, owner-authenticated Agent turn adapter that resolves immutable identity/version and authorized Personal Memory, binds verified repository/PR/base/head context, preserves its isolated read-only runner, and records author/model attribution. Do not route it through normal managed execution until that path can preserve read-only mode. Collaborative channels, rooms and direct/group chats need explicit User-versus-Team identity, audience and memory authorization before invocation is enabled.
- Completion gate: use the chat-surface matrix in `docs/studio-personal-agents-plan.md`; no chat mechanism is complete from mention suggestions alone.
- Completed: managed runtime assembles immutable identity and authorized Personal Memory; the context builder accepts a verified Project scope. Live Studio passes selected Project scope. Each other chat adapter must supply its own verified context.
- Validate restart/reconnect, access isolation and retained history before surfacing verified outputs on Home.
- Completed: encrypted output references and freshness-aware runtime counts; project counts derive from recorded jobs. Add richer project engagement metadata separately.
- Completed: expose actual model/effort and runtime instance for each recorded retry attempt.
- Extend retained job history beyond the first bounded page.

## Studio Pull Requests and Orys integration

Planning baseline: [feature map and porting plan](docs/studio-pr-orys-port-plan.md).

- Completed: Orys feature inventory, initial pure review contracts, and local GitHub Plugins identity connection using explicit GitHub CLI sign-in.
- Completed: repository selection and bounded PR list/detail reads, validated through live and demo browser flows.
- Next browsing work: comments, CI, team-request membership and actual review history. Preserve Orys safety contracts throughout the remaining TypeScript port.
- Port PR browsing, review execution, findings and confirmed publication as separate tested slices.
- Completed: read-only PR Chat using the isolated Codex runner, account/repository/commit-scoped conversations, and GitHub plugin reconnect/disconnect/browse flow.
- Add durable PR conversation storage and authorized memory context without changing independent review or publication boundaries. Current preview conversations are in-process only; service restart clears them.
- Include desktop notifications with preferences, privacy, deduplication and validated PR deep links.
- Port pipeline tooling, history/export, recovery, diagnostics and evidence cleanup.
- Keep current UI skin; validate required additions before expanding scope.

## Studio Personal Home integration

Preserve the imported UI. See [the wiring plan](docs/studio-home-wiring-plan.md).

- Superseded: captured-content navigation from Home/Chats. Replace with explicit workflow destinations, never a history-viewer fallback.
- Completed: stable project-ID filtering across captured conversations, executions and requests.
- Completed: scope isolation, canceled stale reads and visible source coverage warnings.
- Reuse connection/capability services; confirm the intended upstream before changing routing.
- Implement the agreed New chat suggestion/draft flow, then port managed conversation launch/runtime/approval contracts.
- Define evidence-backed before/after change preparation, per-user seen checkpoints and relevance ranking for personalised Home invitations.
- Reuse project metadata and define separate Electron/browser directory behaviour.
- Validate each slice in the imported UI before selecting another page.
- Resolve imported prototype lint errors and the Electron CommonJS lint configuration before PR readiness.

## Joining-device-first Personal Device pairing

Implemented on 2026-09-14:

- Joining headless and Electron installations create a short-lived device request.
- The existing Authority-hosting Electron installation reviews and explicitly
  accepts that request, using the existing signed enrollment protocol.
- `pnpm koed-server pair` starts the native Personal runtime with automatic ports
  and credentials. CLI and Electron share supervisor-owned request state.
- Setup no longer requires a recovery JSON export or a recovery code. Advanced
  optional recovery export remains available through the CLI.
- Joined devices publish their own closed sessions without an Authority private
  key. User authentication and secure membership context remain required.
- Request transport is private LAN/Tailscale only. The existing Authority relay
  listener remains in Electron; the joining request listener lives in koed-server.

Validation and current operation are documented in `docs/device-pairing.md`.

Deferred work:

- Internet-accessible relay and restricted-network traversal.
- Approval from joined replicas that do not host the Authority.
- Moving the existing Authority relay listener into the supervisor.

## Personal Device session visibility and automatic publication

Implemented, following ADR-0045:

- Signed cumulative checkpoints preserve V1 permanent closure semantics.
- Durable Pi, Codex, and Claude Code completion evidence triggers publication.
- Ordered, deduplicated checkpoints extend one read-only received Session.
- Pairing and local replication progress are reported separately.

Remaining validation: physical Studio-to-Electron capture, later-turn updates,
and offline catch-up on the updated runtime.

Implemented: received-session badges use verified replica provenance and the
installation-local nickname; device icons no longer guess hardware by row order.

## Studio frontend simplification

Agreed sequence after the frontend QA review: begin with unused UI removal and small shared adapters/cards. Preserve the current design and Desktop/web behavior. Further extraction should land before colleagues begin work in the affected components.

- Completed: share human Team message-row presentation; Desktop/web visibility and read-receipt contracts remain separate.
- Completed: extract repeated Project Move pickers and Team review/message actions; runtime and recovery controllers remain separate.
- Completed: share Team Memory settings presentation through existing Desktop/web data adapters; transport, permissions and stale-result guards remain in each controller.
- Defer larger controller or composer restructuring until upcoming ticket ownership is known.

## Agents library overview

Implemented: shared Desktop/web Cards/List views, lifecycle filtering and
automatic verified current-work summary. See `docs/studio-personal-agents-plan.md`.

For very large Agent collections, consider a compact owner-scoped bulk activity
read so the overview does not hydrate full history for each Agent. Keep the
existing lease/generation verification and explicit unknown states. Current
reads are paced; this is a performance follow-up, not a new authority contract.
