# Pull request review in Project HQ

Project HQ reads pull requests and checks through a Managed Conversation's
runner-bound source-control route. It also asks the local API to reconcile
linked Work Items. The API derives the Work Item's execution and pull request
binding, reads the provider's current pull request and checks, and advances a
Work Item to Done only after the provider reports `merged`. A pull request
closed without merging makes the Work Item blocked. The renderer and Agent do
not submit a pull request state for this transition.

An Agent may call `review_request_merge_propose` with a pull request number.
The managed worker observes the completed Koed tool call under its command
lease and records a proposal selector in that Conversation's runtime items.
The tool grants no source-control authority. If the number matches more than
one repository in the execution, HQ requires the User to choose the intended
pull request.

The Merge button and an unambiguous Agent proposal use the same Desktop merge
client. Koed prepares an exact operation, displays its repository, pull
request, target, head, method, checks, review state, digest, and expiry in
Native review, then dispatches only after approval. Full access does not skip
Native review. A decline leaves the Work Item In review. If dispatch loses its
response, Desktop keeps the operation ID for read-only status reconciliation;
it does not repeat the merge request. The server's durable journal remains
authoritative, so clearing Desktop state cannot create another mutation while
an earlier operation is unresolved.

For an Agent proposal, a Native decline is stored against the exact proposal
item. Koed includes a fixed status line on the Agent's next genuine User
prompt. It does not resume a stopped Agent or create a User message. An
in-flight prompt has no shared live notification channel across providers.
The declined proposal grants no later merge authority; a new User request
still receives fresh Native review.

Only the negotiated version-2 source-control route supports merge. The strict
version-1 source-control contract remains unchanged. Unsupported providers
offer **Open on <provider>**.

Design reference: Orys commit
`41b59cde1184c4025957f0d3542ca46d1b1124c4`, ADR 0006. Borrowed the
concept of exact confirmation, one-use authority, and read-only recovery.
No Orys code or merge driver was copied.
