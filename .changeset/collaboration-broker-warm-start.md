---
"@koed/desktop": patch
"@koed-labs/server": patch
---

Koed opens much sooner on a busy Mac. Its first screen waits for a small helper program, which Koed now starts as soon as the app launches instead of on first use. Koed also no longer gives up on that helper when it takes longer than ten seconds to start; it used to restart the helper, which kept the first screen waiting for a minute or more.
