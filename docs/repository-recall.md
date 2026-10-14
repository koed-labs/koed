# Personal Repository Recall

The Project integration branch targets Personal Memory using one effective
repository identity. The complete release is gated by ticket 16. Team matching
and Personal Device Sync assignment transport are implemented by their later
tickets; repository identity never chooses or authorizes a Workspace.

## Resolve Before Accepting Work

For Project scope, the local adapter resolves the caller's cwd through shared
Project discovery. Subdirectories resolve to the Git root. An explicit path or
catalogued local Project id resolves that requested Project only. An unknown
Project, missing checkout, invalid selected anchor, or failed probe returns a
resolution error. It does not substitute the caller's repository or Global scope.

The accepted task's encrypted request stores `repository_context`: root, identity
kind/key, branch observation, resolution reason, and checkout/device provenance.
Its `project_id` is an opaque scope value derived from kind, key, and the
originating device for local identities. Portable equality ignores checkout paths,
branches, and device provenance. Local repository and non-Git identities also
require the originating device to match.

Remote adapters can supply typed resolved context for a source checkout that is
not present on the serving host, including a Windows path. Such paths are request
metadata; they do not select the local worker's execution directory. The API
rejects Project task acceptance without resolved context or when the supplied
scope value disagrees with it.

Blocking and non-blocking delivery use the same context. Worker replacement and
retry use the stored request, so cwd, anchor, or branch changes cannot retarget
accepted work. Authorized collection belongs to the User and does not depend on
the collector's cwd. Repeated collection reads the encrypted terminal result
without another recall or synthesis run.

Pinning the request does not snapshot Personal Memory. Every query and expansion
checks current assignments, ownership, source eligibility, deletion, and time
bounds. A User override wins even when it is unresolved or local; resetting it
restores the recorded automatic assignment, including unresolved history.

## Retrieval Boundaries

| Surface                                   | Boundary                                                                                                                                             |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Raw Memory Events and messages            | Semantic candidate SQL checks the owning Session's current effective identity before candidate limits.                                               |
| Memory Node semantic search               | Matching source membership, filtered source items, and out-of-window diagnostics use the same identity predicate.                                    |
| Memory Node expansion                     | Current Session assignments filter source rows; capture-time source JSON cannot authorize Project evidence.                                          |
| Curated Memory search                     | Active source evidence must match the effective identity; deleted/excluded sources cannot establish scope.                                           |
| Curated Memory expansion                  | Scope and time bounds filter source links; a scoped summary cannot include known source Sessions outside that boundary.                              |
| Graph and memory-browser collections      | Project predicates use effective identity instead of captured ids, cwd, or paths. Direct owner inspection by source id remains owner-authorized.     |
| Materialized Personal replicated evidence | The same Session predicates apply to local source rows, alongside existing replication-readiness checks. Assignment transport is added by ticket 11. |
| Durable task completion                   | The final Memory Question must retain the accepted Project scope.                                                                                    |

`repository_scope_matches` is the shared SQL equality boundary. It returns false
for unresolved identities, malformed scope values, and path-only inputs. It is
only a narrowing predicate; callers retain all existing User and source-access
checks. API retrieval clients carry the opaque `project_id` through search,
expansion, and graph requests. Diagnostic local tools resolve the same context.
Session scope still targets its explicit Session; Global scope retains its
existing authorized search behavior. Neither uses repository equality as an
access grant.

Evidence selection, chunk identities, source references, lineage, and budgets
are unchanged. Existing semantic scoring and candidate fusion remain in use;
there is no additional ranking model and no backend LLM synthesis.

## Verification

The shared identity fixtures cover repository selection. Focused PostgreSQL
checks exercise raw semantic search, nodes, graph browsing, Curated Memory search
and expansion, current overrides, and unresolved assignments. Adapter checks
cover explicit Project targeting and immutable request context. Durable task
checks cover encrypted context across worker replacement, terminal persistence,
and repeated owner collection. Semantic tests use deterministic embedding vectors;
they validate boundaries, not model answer quality.
