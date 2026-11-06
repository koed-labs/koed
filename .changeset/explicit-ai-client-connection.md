---
"@koed-labs/server": minor
---

Only setting up or repairing an AI Client now connects it for capture, and only after Koed verifies the integration for the current `KOED_HOME`. Status checks no longer connect clients. Removing a client disconnects it before its integration is changed, so a removal that fails or is interrupted still stops capture, and a setup that was running when the client was removed can no longer reconnect it. Headless remote runtimes no longer reconnect clients when they start. Existing installations must connect each AI Client again, through Koed Desktop or `koed setup <client>`; no Memory is deleted.
