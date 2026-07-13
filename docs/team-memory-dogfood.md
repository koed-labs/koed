# Team Memory Dogfood Project Mapping

This is a rough local dogfood path for sharing one Project's Personal Captured
Sessions into a Team Workspace and recalling Team-shared Memory from the MCP
Server. It is not polished Electron UI.

## Boundaries

- API Tokens remain Personal Memory compatibility credentials. They can locate
  the latest Personal Captured Session, but they cannot create Share Grants or
  authorize Team Workspace recall.
- Team-shared Memory stays user-owned. Sharing uses Team Workspace Share Grants
  for Captured Sessions.
- The Project root is lookup and display metadata. The Team Workspace id is the
  stable authorization boundary.
- Project mapping config stores no secrets. It only stores Project root, Team
  Workspace id, optional backend id, and timestamps under
  `KOED_HOME/config/project-team-workspaces.json`.
- Team recall is opt-in. Personal Memory remains the MCP default.

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
recall requests.

Inspect or remove mappings:

```bash
node packages/koed-server/dist/cli.js team workspace list --json
node packages/koed-server/dist/cli.js team workspace show --project-root "$PWD" --json
node packages/koed-server/dist/cli.js team workspace remove --project-root "$PWD" --json
```

## Share A Captured Session

The share command needs a browser session cookie for the Team user because Share
Grant management is session-only in this dogfood path.

```bash
KOED_TEAM_SESSION_COOKIE="cm_session=<local-session-secret>" \
node packages/koed-server/dist/cli.js team capture share-latest \
  --project-root "$PWD" \
  --json
```

`share-latest` uses the Personal Memory API Token only to find the latest
Personal Captured Session for the Project. It then creates the Share Grant with
the browser session cookie. To share a selected Captured Session without latest
lookup:

```bash
KOED_TEAM_SESSION_COOKIE="cm_session=<local-session-secret>" \
node packages/koed-server/dist/cli.js team capture share-latest \
  --project-root "$PWD" \
  --session-id "<captured-session-uuid>" \
  --json
```

If no matching Project mapping, browser session cookie, or Personal Captured
Session exists, the command fails clearly.

## Recall From MCP

Explicit Team Workspace recall can be requested through `memory_answer`:

```json
{
  "query": "What did the Team decide about the workspace timeline?",
  "search_domain": "project",
  "workspace_id": "/absolute/project/root",
  "team_workspace_id": "<team-workspace-uuid>",
  "response_detail": "with_citations"
}
```

Project mapping auto-resolution is opt-in:

```bash
KOED_TEAM_MEMORY_DOGFOOD=1 koed-mcp
```

With that flag, `memory_answer` resolves the current Project root against
`KOED_HOME/config/project-team-workspaces.json` and includes the mapped
`team_workspace_id` on Team recall requests. If the mapping also has a backend
id, MCP sends the request through the local `koed-server` local-edge upstream
proxy. Enrollment creates two distinct scoped credentials in secure local
storage. A Local-Edge Client Credential authorizes MCP to ask the local proxy
for `team_workspace_read`; a separate upstream device credential authorizes the
local edge against the Team Backend. MCP never receives the upstream credential,
and a Personal API Token never enters or authorizes the Team path.

Team Workspace recall still fails closed when no mapped backend id is available,
the upstream backend is not enrolled, the upstream capability cache is stale, or
the upstream route policy does not explicitly enable Team Workspace read.
Disconnecting removes both local credential classes and disables route policy;
Personal Memory API Tokens continue to work only for local Personal Memory.

## Cleanup

Remove the local Project mapping:

```bash
node packages/koed-server/dist/cli.js team workspace remove --project-root "$PWD" --json
```

Revoke a Share Grant through the existing Team Workspace API or Team UI:

```bash
curl -X DELETE \
  -H "content-type: application/json" \
  -H "cookie: cm_session=<local-session-secret>" \
  -d '{"reason":"dogfood cleanup"}' \
  "http://localhost:3300/v1/team-workspaces/<team-workspace-uuid>/session-share-grants/<share-grant-uuid>"
```
