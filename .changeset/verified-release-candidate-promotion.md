---
"@koed-labs/server": minor
"@koed/koed": minor
---

Support pinned component generation upgrades across versions while preserving the prior generation's component presence in upgrade status. Release promotion now verifies candidates against protected reviewed-build identity before any publication: the npm package is inspected statically (archive safety, ESM package scope, and generated CLI admission bindings), downloaded assets must match the protected build bytes before they are read, and candidate code is never executed in the credential-bearing verifier.
