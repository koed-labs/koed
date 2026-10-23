---
"@koed/api": patch
"@koed/db": patch
"@koed/desktop": patch
"@koed/shared": patch
---

Making a shared Project Conversation private now freezes its exact Share Grant, preserving the last shared summary while excluding later messages.

Captured Session sync publishes Memory Events and their semantic source links atomically and reads a consistent snapshot, while continuing to reject malformed provenance.
