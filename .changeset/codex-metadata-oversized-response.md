---
"@koed/koed": patch
---

Keep Codex history capture moving when one paginated Conversation returns a
very large native metadata page, for example because of inline images. The
metadata line limit rises from 256 KiB to 1 MiB. A larger response now fails
only its own Conversation with `codex_history_response_oversized` and retries
with backoff, instead of stopping metadata reads for every Conversation in the
same Codex home. Discarded bytes stay bounded, and unattributable oversized
output still fails closed.
