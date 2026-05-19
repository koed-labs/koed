---
Status: deferred
---

# Bind API token team access at creation time

Team-scoped API token behavior is out of scope for the current personal-token build. When team-scoped tokens return to scope, the leading candidate decision is that API tokens remain user-owned credentials and any team access comes from a fixed team scope assigned when the token is created. This should be revisited alongside current-team fallback, active membership, team recall, and whether team-scoped tokens may also read Personal Memory.
