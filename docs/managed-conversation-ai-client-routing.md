# Managed Conversation AI Client Routing

Managed Conversation start requires explicit AI Client driver and instance. Desktop sends both values; no provider default is applied. Local authority and local-edge proxy admission require an enabled instance whose current capability snapshot is healthy, authenticated, non-stale, identity-matched, and ready for the requested operation. Hosted authority skips unrelated hosted snapshot admission for device-authorized deferred local execution; exact target Worker/runtime readiness remains fail-closed. Pi is visible as unsupported and fails closed. Missing capability state never falls back to another AI Client.

`managed_conversation_executions.ai_client_instance_id` records execution owner separately from provider/model identity. Migration `0033` backfills `${provider}.default` when valid, preserves a valid provider identity when possible, and otherwise uses deterministic `legacy.` plus an MD5 digest; it enforces the 128-character bound and intentionally has no foreign key so execution history survives client removal.

Worker runtime creation, resume, reconciliation, handoff, and fork resolve exact persisted driver/instance registry entries. Capability publication binds discovered installation identity and canonical registry configuration identity into one non-secret hash; executable stat changes invalidate reuse. Only Codex app-server and Claude Agent SDK lifecycles are valid. Pi and missing instance configuration fail closed; no Pi synthesis RPC or cross-client fallback is used.

Desktop displays execution owner (`driver · instance`) and gates start, resume, send, and transfer controls from owner capability readiness. Codex and Claude publish ready for implemented start, resume, send, session identity, handoff, and fork. Cancellation, approvals, and provider-token streaming remain explicitly unsupported bounded differences for current Codex, Claude Code, and Pi Managed Conversation UI; Desktop exposes no controls for them. Pi publishes all managed capabilities unsupported. Diagnostic controls remain disabled when owner capability snapshots are stale, unavailable, unauthenticated, or unsupported. Discovery failures are shown as diagnostics; action-time API checks revalidate current snapshots.

## Conversation ownership versus synthesis

| Surface                         | Owner and source of truth                                                                                                          | Capability gate                                                                                   | Failure boundary                                                                              |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Externally managed Conversation | Codex, Claude Code, or Pi owns process and transcript; Koed's provider-specific Transcript Watcher captures growth                 | Capture and Recall diagnostics for that client                                                    | Capture failure affects that client and source frontier only                                  |
| Managed Conversation            | Koed Local AI Runtime owns lifecycle, while persisted `provider` and exact instance own execution, resume, send, handoff, and fork | Fresh, healthy, authenticated, identity-matched capability for each requested lifecycle operation | Missing, stale, unavailable, or unsupported owner fails closed; no other client is selected   |
| Local Synthesis flow            | Local AI Runtime resolves its own per-flow provider, instance, model, and options                                                  | Fresh local-synthesis capability plus selected model and reasoning effort                         | Failure affects only Memory Answer, LCM Summary, Session Title, or Curated Memory Review flow |

Managed Conversation ownership and Local Synthesis assignment are independent.
Selecting an owner for one does not route the other, and a client that supports
capture or synthesis may still be unsupported for Managed Conversation.

### Bounded UI capability matrix

| Capability               | Codex       | Claude Code | Pi          | Current Desktop behavior |
| ------------------------ | ----------- | ----------- | ----------- | ------------------------ |
| Cancel                   | Unsupported | Unsupported | Unsupported | No control               |
| Approval interaction     | Unsupported | Unsupported | Unsupported | No control               |
| Provider-token streaming | Unsupported | Unsupported | Unsupported | No control               |
