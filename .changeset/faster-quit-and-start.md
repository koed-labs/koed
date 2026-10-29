---
"@koed/desktop": patch
---

Quitting Koed hides its window straight away while local services stop in the background, and a second Quit during that time no longer starts a second shutdown. At startup, Koed notices the local API is ready sooner instead of waiting for a slow status check that began before it came up, and an app that is already running is detected without a status check.
