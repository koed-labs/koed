# Personal AI Client usage

Koed reads subscription usage only from the Codex app server and Claude Agent
SDK, as specified in [ADR 0065](./adr/0065-ai-subscription-usage-official-sources-only.md).
The local runtime checks Codex with the optional `account/rateLimits/read`
method. After capability publication and on manual refresh, a bounded probe
owns a separate app-server connection, so it cannot hold up capability
inspection. After a managed Codex turn, a bounded read uses that turn's
still-open client without delaying completion or closing the shared session.
A missing method or failed check leaves the last reading intact.
Claude's `rate_limit_event` is captured as it arrives, including events received
before a cancelled or failed turn ends. The SDK account is checked at turn start
and again on an event. Changed or unverifiable attribution does not become a
healthy reading. Telemetry deadlines cannot fail a managed turn.

The Personal backend stores each reading in `ai_client_usage_snapshots`, keyed
by the owning User, AI Client instance, hashed account identity, provider
bucket and window. The `ai_client_usage_accounts` binding identifies the
current account epoch and opaque profile scope for each instance. A new binding
hides the previous account's readings immediately; a late result for the old
binding is rejected. Rechecking the same account preserves its epoch, so a
five-hour refresh keeps weekly and model-specific readings visible. A newer
reading for one window does not replace another window. Reads expose the latest
reading per bucket and window and omit readings older than 30 days. The table
contains no transcript, prompt or source content. Usage is outside Memory,
Projection, Team sharing and agent context.

Owner-authenticated Personal routes under `/v1/memory/ai-client-instances/usage`
read the current profile's snapshots. The profile scope is a hash of the
canonical Koed home; its path never crosses the wire. The local runtime binds
an account and writes readings
through the same Personal AI Client route family. After a committed write or a
failed/unsupported probe, the API's Personal event stream carries only instance
ID, completion ID, outcome and observed time. Desktop's dedicated main-process
stream client checks owner, backend, profile credential and enabled instance
authority before forwarding an event through `localAiClients.onUsageChanged`.
On reconnect it sends a catch-up signal so a consumer re-reads snapshots after
the stream attaches. Unsubscribing removes the renderer listener.

`localAiClients.usage()` reads the current owner-authorized projection.
`localAiClients.usage(instanceId)` asks the local runtime for one bounded Codex
check and returns `checked`, `failed` or `unsupported` with the observed time.
The caller must show success only for `checked`; the provider may not share
usage. This API does not change the AI Client selected for a Conversation.
