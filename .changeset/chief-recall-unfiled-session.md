---
"@koed/db": patch
---

Your Chief of Staff can use Koed's memory. A Project HQ Conversation's Session was never filed under its Project, because its private folder is never a local Project checkout, so every memory lookup from it was refused ("Managed Project recall context is unavailable (409)" or "Managed Project recall authority changed"). Koed now files that Session under its Project when the Conversation starts, and files existing ones on their next turn, unless the Session has been moved elsewhere.
