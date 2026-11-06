---
"@koed-labs/server": minor
---

Koed now reads an AI Client's conversations only while you have connected it. A client that is detected but not connected is no longer captured or imported, and connecting or disconnecting takes effect within seconds, without a restart. Automatic history import no longer stalls: a Conversation that fails the same way on every pass is skipped and logged instead of holding back newer ones, a closed import run is replaced with a new one, failures record the Memory API's error code, and a restart no longer marks history as stuck.
