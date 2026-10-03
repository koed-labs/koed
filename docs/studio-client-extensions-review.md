# Studio AI Client resources

Studio reads Skills and installed client resources from the AI Client instance
that owns them. Discovery is read-only, scoped to the User, authorized
computer, AI Client instance, and Project. It does not create a managed
Conversation or Job.

## Native sources

- **Codex** uses the production app-server `skills/list`, `app/installed`, and
  `mcpServerStatus/list` methods. The experimental plugin-management methods
  are not used.
- **Claude Code** reads supported commands and configured plugin/MCP status
  through the Claude Agent SDK with user and Project settings enabled,
  `strictMcpConfig`, no tools, an empty prompt, and session persistence off.
  The SDK query is aborted at the native read deadline. Koed does not install
  or rewrite Claude settings.
- **Pi** reads Skills and extensions through the configured Pi installation's
  public `DefaultResourceLoader` SDK in a bounded child process. Koed kills the
  child if a native SDK reload does not finish before its deadline.

Resource discovery uses the exact AI Client executable/configuration registered
on the target computer. A failed or unsupported native read is reported as a
bounded operation error. It does not cause Koed to copy credentials, source
files, or client settings to another computer.

## Catalog and execution

The Studio gateway starts `POST /v1/ai-client-resources/discover` with the
authorized hosted instance ID, Project ID, and request ID. The request creates a
bounded operation assigned to that instance's authorized runner. Studio polls
the operation ID until it completes or reports an error. A catalog includes
opaque resource IDs, names, descriptions, kind, status, source, scope, and
observation/expiry times. It does not include client paths, configuration
contents, credentials, or Skill source text.

The runner resolves the Project path from its local Koed Project catalog. A
browser-provided path is never accepted. On invocation, the worker repeats
native discovery on the same computer and Project and rejects missing, stale,
disabled, or cross-scope selected Skill IDs. The provider receives the native
Skill selection through its supported invocation interface; Koed does not
paste Skill contents into the prompt. Native discovery is bounded and active
runner leases are renewed until the operation completes or reaches its deadline.

Discovery and execution require the same owner, hosted instance, runner device,
deployment, and Project scope. Runner operations use short leases and are
retried a bounded number of times. Installation, account connection, and client
configuration remain in the original AI Client.

## Local acceptance on 2026-10-02

Read-only discovery against the configured Mac instances returned 51 Codex
resources: 30 Skills, 12 installed apps, and 9 MCP servers. The registered
Claude executable did not resolve on this computer, so that instance returned
the safe `AiClientExecutableUnavailable` status. An in-memory fixture using the
current installed Claude executable and the same registered configuration
directory completed read-only discovery with 66 resources: 62 Skills, 3
plugins, and 1 MCP server. The explicit probe disabled session persistence and
did not change the registered instance. No provider paths or error details were
emitted. Pi was not registered with Koed. An explicit in-memory fixture used
the installed `@earendil-works/pi-coding-agent` 0.84.2 public SDK and preserved
the command wrapper's local-only sandbox profile and offline environment. It
found 1 Skill and no extensions. No Pi registry or configuration files were
changed.

## Final staging probe and database correction

The isolated owner-authenticated hosted discovery probe exposed a real PostgreSQL error while creating a discovery operation: inconsistent parameter types in the scoped insert. The query now consistently casts the target device identifier as text and the deployment identifier as UUID, including the metadata comparison. A maintained disposable PostgreSQL integration test migrated an isolated database and successfully created the same scoped operation. DB typecheck and formatting also passed.

This corrects operation creation; it does not certify a completed hosted native catalog or Skill invocation. The live review execution was stopped through the supported command and its disposable runtime/profile were removed. Real read-only provider discovery evidence above remains valid; end-to-end hosted discovery and invocation remain separate acceptance items.
