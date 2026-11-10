---
"@koed-labs/server": minor
---

Add a versioned standalone Server installer for macOS arm64 and Linux x64, published with each release as `install-koed-server.sh`. It installs the matching `@koed-labs/server` package with a compatible or private Node, provisions Base, the native runtime and the embedding model through the release provider, starts the server and verifies readiness without Homebrew, `sudo` or AI Client configuration. The release provider now supports macOS arm64 native runtime assets.
