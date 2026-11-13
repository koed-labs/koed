# Personal Project Recall

Implicit `memory_answer` requests with `search_domain=project` select the union
of the canonical Personal Projects containing the current Conversation. The
database resolves that Conversation's membership using the same inclusion rules
and exclusions as the UI. Membership in A or B selects eligible Memory from A or
B, without recursively including a third Project through another Conversation.
Overlapping membership does not duplicate Memory.

The AI Client integration supplies per-call Conversation context: either the
captured Session UUID through a trusted caller-context resolver or the native
Conversation ID together with its AI Client runtime. Codex native MCP request
`_meta.threadId` and trusted caller-context resolvers constrain hook-supplied
body fields; conflicting identities reject the call. MCP transport `sessionId`
is not a native Conversation ID. The MCP Server resolves the binding with
`POST /v1/personal/projects/resolve-recall`, under the authenticated User. A
missing or invalid binding, an unavailable Conversation, or zero Project
memberships produces an explicit error. There is no repository, Folder, or
Global fallback. A caller's repository context does not select this scope.

Pi's existing extension sends `sessionManager.getSessionId()` as the native
`pi` Conversation ID in both blocking calls and non-blocking task submissions.
This is the raw Session header ID used by the Transcript Watcher, not a transport
ID or a cwd-derived value. Missing identity is left unresolved; ephemeral or
uncaptured Conversations still require a resolvable capture or an explicit target.

Canonical default Project organization runs in the existing background service,
independently of the UI. Once its Git Anchor rule exists, later Conversations
matching that rule belong to the same Project immediately, including another
checkout. Resolution does not create Projects or force reconciliation. Before
initial organization completes, an owned Conversation with no available Project
returns HTTP 409 `personal_project_membership_pending` with `retryable: true`
when the owner's durable reconciliation flag is pending. That flag is owner-wide,
so unrelated pending organization can temporarily produce this outcome too.
After reconciliation finishes, zero membership returns
`personal_project_membership_missing` with `retryable: false`. An active owned
Conversation whose source binding is explicitly pending verification returns
409 `personal_conversation_pending` with `retryable: true`; missing, deleted,
foreign, and otherwise unavailable Conversations do not become retryable merely
because resolution failed. Ambiguous bindings remain explicit nonretryable errors.

Hook-only body fields, including Claude's `conversation_id` and
`conversation_source`, are client claims rather than cryptographic proof that
a hook supplied them or that they identify the currently executing Conversation.
Resolution verifies the authenticated User owns the claimed Conversation. It
cannot expose another User's Personal Memory; the claimed context selects scope
within the same User's Memory, not an authorization boundary. Explicit Global
Personal recall remains available to that User without a Conversation binding.

Resolution occurs before durable task acceptance. A version-one Personal
selection stores the resolved Project references and caller Session UUID, with
no synthetic repository or Project ID. The same accepted selection accompanies
search and expansion; retries do not discover a replacement selection. Existing
owner, eligibility, deletion and time restrictions still apply. Completed and
failed task output carries the same selection into question history. The resolved
caller Session identifies the Conversation for membership resolution; it is not
a query Session filter. Use `search_domain=session` for that narrower scope.

Existing explicit `recall_target` Project and exact Folder requests retain their
targets. `search_domain=session` retains its explicit Session selector, and
`search_domain=global` remains available without a current Conversation binding.
The deprecated explicit legacy `project_id` selector remains a separate
repository-compatibility path; it is not a named Project or the implicit default.
No new narrower Project discovery or selection workflow is required.

Explicit Team Workspace routing remains separately authorized and does not
resolve a Personal Project union. Personal selections cannot be combined with
Team routing. These changes do not alter Team membership or sharing authority.
