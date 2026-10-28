---
"@koed/desktop": minor
---

Solo edition and a steadier Desktop on a busy Mac. Koed now runs the Solo edition unless `KOED_EDITION=full`: no Project or chat creation, Team and sharing, hiring agents, scheduled jobs, decks, to-dos, activity, chat moves or usage table, and the phone stays off unless `KOED_PHONE_ENABLED=true`. A Project page lists its conversations. Identical local API reads made at the same time now share one request, the API address is looked up with one `koed status` at a time and not after a slow answer, chat composers keep retrying their AI Client options while Koed starts, open chats read launch options every 30 seconds instead of every 2, and an existing chat shows "Loading" or "Try again" instead of an empty New Conversation page. Managed Conversation failures now log their cause.

Project, Scheduled Job and Agent reads no longer run `koed status` before every request; they reuse the known API address and look it up again only after a connection failure (Team sharing still verifies). Slow `koed` CLI runs are logged.
