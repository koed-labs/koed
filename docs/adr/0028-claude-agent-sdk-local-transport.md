# ADR 0028: Use the pinned Claude Agent SDK with local Claude Code

## Status

Accepted

## Decision

Koed's Claude-managed Answer Synthesis and summary flows use the pinned official
TypeScript `@anthropic-ai/claude-agent-sdk` package exclusively. The SDK is
given the canonical real path of a separately installed Claude Code executable
and reuses that installation's subscription authentication.

Koed does not invoke Claude Code directly as a fallback synthesis transport,
accept an Anthropic API key for these flows, or bundle a Claude Code runtime.
The local executable path and authentication state stay on the User's machine
and are not persisted in or sent to the Koed backend.

Codex remains an independent local provider. Each local synthesis flow can
select its provider and model independently; changing one flow does not imply a
global provider switch.

Managed Conversation coordination owns a single provider-tagged runtime session
registry and a single lease-renewal and fencing path. Provider adapters retain
their transport-specific start, resume, prompt, source-sealing, and fork
mechanics, but they cannot independently redefine execution ownership or lease
loss behavior.

## Consequences

- Claude availability fails closed when the configured executable is missing,
  cannot be canonicalized, or is not signed in.
- SDK upgrades are intentional dependency changes rather than floating runtime
  behavior.
- Koed inherits the User's Claude Code subscription and local configuration
  boundary without becoming a provider-credential custodian.
- Provider/model readiness must be reported per flow because Codex and Claude
  can be installed, authenticated, and configured independently.
