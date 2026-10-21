# Team Workspace Project Mapping

This CLI-based workflow links one local Project to a Team Workspace so the MCP
Server can recall Team-shared Memory for that Project. Project mapping does not
create or authorize Shared Memory.

## Boundaries

- API Tokens remain Personal Memory compatibility credentials. They cannot
  create Share Grants or authorize Team Workspace recall.
- Team-shared Memory stays user-owned. Sharing requires the explicit Shared
  Memory preview, owner consent, and Share Grant authority flow.
- The Project root is lookup and display metadata. The Team Workspace id is the
  stable authorization boundary.
- Project metadata config stores no secrets. It stores local discovery facts
  under `KOED_HOME/config/projects.json`, including raw paths for local-only
  display and salted path hashes for matching.
- The first-class Personal Project association and its retained checkout
  history are separate from this recall-routing mapping. The first-party
  Codex, Claude Code, and Pi transcript watchers keep raw Git-directory and prior-folder evidence, confirmation
  choices, and retry records in `KOED_HOME/config/project-associations.json`.
  The Personal database stores owner/device-scoped opaque context identities.
  Neither this file nor paired-device alias grouping grants Team access.
- Project mapping config stores no secrets. It stores Project root, optional
  device-local Project id, Team Workspace id, optional backend id, and timestamps
  under `KOED_HOME/config/project-team-workspaces.json`.
- Team recall is opt-in. Personal Memory remains the MCP default.

## Discover Project Metadata

Discover the current Project before linking it. This records local repo/cwd
metadata for matching and display only; it does not grant Team Workspace access.

```bash
node packages/koed-server/dist/cli.js project discover --cwd "$PWD" --json
node packages/koed-server/dist/cli.js project show --cwd "$PWD" --json
node packages/koed-server/dist/cli.js project list --json
```

Discovery records Git root, normalized remotes with credentials stripped,
branch, HEAD commit, package name, and device-local Project id. Individual
current and historical network remote aliases are non-authoritative matching
signals; changing the remote set does not change local Project identity or
relink a Workspace. Raw local paths remain local under `KOED_HOME`.

Discovery inspects only the supplied directory and its enclosing Git repository.
It does not recursively discover child repositories, submodules, or monorepo
packages. Separate Git worktrees retain separate local Project ids while a
salted common-directory hash records that they share one device-local Git
repository. A repository without a remote has no portable matching signal and
must be linked explicitly on each device.

Future trusted personal-device enrollment may use remote-alias overlap to
associate Project contexts across devices. That personal association is not
implemented here and must remain separate from explicit Project-to-Team
Workspace links.

## Link A Project To A Team Workspace

```bash
node packages/koed-server/dist/cli.js team workspace link \
  --project-root "$PWD" \
  --team-workspace-id "<team-workspace-uuid>" \
  --json
```

Use `--backend-id <id>` if the local Project mapping should record which
registered backend owns the Team Workspace. `--upstream-backend-id <id>` is
accepted as the same value for local-edge setup flows. The backend id is not a
secret; it tells MCP which enrolled upstream should receive Team Workspace
recall requests. Advanced/headless callers may also pass `--local-project-id`
and `--project-display-name` from `project discover` output. Remote
fingerprints cannot select or authorize a Team Workspace. Existing experimental
mappings that relied only on `sourceProjectId` must be rediscovered and linked
again with an explicit Project root.

Inspect or remove mappings:

```bash
node packages/koed-server/dist/cli.js team workspace list --json
node packages/koed-server/dist/cli.js team workspace show --project-root "$PWD" --json
node packages/koed-server/dist/cli.js team workspace remove --project-root "$PWD" --json
```

## Recall From MCP

Managed Project HQ Conversations use a separate first-party recall route. The
local runner binds each MCP or Pi launch to its execution id and generation.
At task execution, Koed resolves the owned logical Session to its effective
Personal Project, then reads that Project's current explicit Team link. The
Personal branch searches that Project plus Me assertions. A linked Team branch
searches the selected Workspace globally, using the enrolled backend and the
Team task's independent authorization boundary. It does not send the Personal
Project id as a Team project filter. The combined result records both branch
questions and citations; if Team cannot be checked, it includes an explicit
Team-not-checked notice. The durable non-blocking task follows the same route.
Legacy path mappings below remain for ordinary external MCP callers and never
select the Workspace for a managed Project HQ Conversation.

Call `memory_workspaces` with `{}` to discover authorized Team Workspaces across
enrolled backends. The tool reads `/v1/team-context` through the existing local
edge and returns Team/Workspace names, access, `team_workspace_id`, and
`team_backend_id`. Pass `team_backend_id` to discovery to inspect one backend.
It returns no credentials, source content, or Share Grants. Failed backends
appear in `unavailable_backends`; an unavailable backend does not mean its
memory is empty.

If discovery reports `capabilities_not_validated`, recheck the existing
enrollment with `koed-server upstream refresh --id <enrolled-backend-id> --json`.
This refreshes the capability cache without changing permissions or credentials.

Select the relevant returned Workspace and request Team recall:

```json
{
  "query": "What dinner plans have Team members shared?",
  "search_domain": "global",
  "team_workspace_id": "<team-workspace-uuid>",
  "team_backend_id": "<enrolled-backend-id>",
  "response_detail": "with_citations"
}
```

`global` searches all shared memory in the selected Workspace. Without a
Workspace selector, it searches Personal Memory. `project` and `session` also
filter shared memory by the source's Project or Captured Session. A local
Project path may differ from a teammate's source Project, so use `global` for
Workspace-wide questions. Query multiple relevant Workspaces separately.

An explicit `team_backend_id` takes precedence over the matching Project link
and `KOED_TEAM_UPSTREAM_BACKEND_ID`. If none is supplied or configured, MCP
discovers the requested Workspace across enrolled backends. It selects a
backend only when discovery succeeds and the Workspace matches exactly one
backend. Ambiguous, unavailable, or unauthorized routes fail closed; they do
not fall back to Personal Memory.

Discovery and recall use the same enrollment under `KOED_HOME` as Desktop.
Electron does not need to be running. Headless `koed-server` enrollment,
existing MCP configuration, and explicit Project mappings remain supported.
Opening a Workspace in Electron does not select MCP scope.

In a managed Desktop conversation linked to a Personal Project, Koed captures
the execution identity and generation when it launches the provider. Recall
then resolves that owned execution to its current Personal Project and exact
Project-to-Team link. The Personal branch searches that Project plus the
owner's `Me` assertions; the Team branch searches the linked Workspace with
`search_domain=global`, without a Project filter. Model-supplied Project and
Workspace selectors cannot replace the captured link. A generic MCP process
without this managed identity retains the existing explicit routing behavior.

Deferred combined recall is one durable parent task with a separately leased
Team child. The scheduler executes that exact child under the parent's capacity
slot and retains the Team child's own signed authorization, lease, and fence.
After a restart it can reclaim eligible tasks. A missing or revoked Team route
leaves Personal evidence available but records **Team not checked** in the
completed result, including after reload. Managed citations store separate
Personal and Team branch receipts tied to the observed provider tool call;
aliases identify evidence but do not authorize later detail access. Detail
reads recheck current source authority, so a revoked Team citation remains
listed with its details unavailable.

The Local AI Runtime advertises its supported tools and Team backend selection
capability. An upgraded MCP adapter omits `memory_workspaces` when an older
running runtime lacks support. Existing recall remains available. New Team
backend input returns a restart message instead of reaching an unsupported
runtime contract. Restart the Local AI Runtime and reconnect MCP to enable the
new features. Workspace UUID matching ignores hexadecimal letter case.

Explicit Project-scoped Team recall remains supported:

```json
{
  "query": "What did the Team decide about the workspace timeline?",
  "search_domain": "project",
  "project_id": "/absolute/project/root",
  "team_workspace_id": "<team-workspace-uuid>",
  "response_detail": "with_citations"
}
```

Project mapping auto-resolution is opt-in:

```bash
KOED_TEAM_WORKSPACE_AUTO_RESOLUTION_ENABLED=true koed-mcp
```

With that flag, `memory_answer` resolves the current Project against
`KOED_HOME/config/projects.json` and
`KOED_HOME/config/project-team-workspaces.json`. Resolution uses only an
explicit mapping for the exact Project root or its stored device-local Project
id. Remote fingerprints may support future match suggestions, but never select
or authorize a Team Workspace. If the mapping also has a backend id, MCP sends
the mapped `team_workspace_id` request through the local `koed-server`
local-edge upstream proxy. Enrollment creates two distinct scoped credentials in
secure local storage. A Local-Edge Client Credential authorizes MCP to ask the
local proxy for `team_workspace_read`; a separate upstream device credential
authorizes the
local edge against the Team Backend. MCP never receives the upstream credential,
and a Personal API Token never enters or authorizes the Team path.

Team Workspace recall still fails closed when no unique backend can be resolved,
the upstream backend is not enrolled, the upstream capability cache is stale, or
the upstream route policy does not explicitly enable Team Workspace read.
Disconnecting removes both local credential classes and disables route policy;
Personal Memory API Tokens continue to work only for local Personal Memory.

## Cleanup

Remove the local Project mapping:

```bash
node packages/koed-server/dist/cli.js team workspace remove --project-root "$PWD" --json
```

Separately forget Project metadata and retained remote-alias history when it is
no longer wanted locally:

```bash
node packages/koed-server/dist/cli.js project forget --local-project-id "<local-project-id>" --json
```
