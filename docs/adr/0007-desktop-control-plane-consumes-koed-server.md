# Proposed Desktop Control Plane Consumes koed-server

Status: Proposed for KOE-217 and KOE-243.

Related proposals:

- [0005 Proposed Native Bundled-Local Runtime Asset Provisioning Boundary](./0005-bundled-local-runtime-asset-provisioning.md)
- [0006 Proposed macOS Homebrew-First Runtime Provisioning](./0006-macos-homebrew-first-runtime-provisioning.md)

## Context

KOE-217 is developing the Electron Desktop control plane for Koed. KOE-243 is
developing the local personal dependency path where Koed can run without an
Operator-managed Docker Compose stack, external Postgres, or external Redis.
These efforts overlap at first startup, local service lifecycle, diagnostics,
current local/self-hosted credential setup, AI-client integration setup, and
runtime asset provisioning.

Desktop is expected to support more than one backend target over time: local
personal `koed-server`, Team Self-Hosted Koed, Koed-managed cloud, and developer
mode. Only the local personal target implies Desktop-managed local service
lifecycle. Remote, Team Self-Hosted, and Koed-managed cloud targets are
connect-only from Desktop's perspective.

Koed already has a headless `koed-server` surface for starting, stopping,
restarting, and inspecting local services. That surface is the natural place to
own service lifecycle, dependency-mode resolution, runtime status, diagnostics,
setup actions, and machine-readable contracts. Electron Desktop can make those
flows approachable, but duplicating the same logic in Electron would create two
control planes with different behavior.

The product needs a durable boundary before the Electron work lands on `main`:
Desktop should be the Operator-facing control surface, while `koed-server`
remains the single implementation of local control-plane behavior.

## Decision

This ADR proposes that Koed Desktop consume `koed-server` control-plane
capabilities rather than reimplement them.

- `koed-server` should remain the source of truth for local service lifecycle,
  dependency-mode resolution, setup, status, diagnostics, logs, and verification.
- Koed Desktop should be an Operator-facing control surface and orchestrator.
  For the local personal target, it may start, stop, restart, and monitor a
  managed `koed-server`, but it should do so through stable `koed-server`
  command or API contracts. For Team Self-Hosted, Koed-managed cloud, and other
  remote targets, Desktop should connect to the selected backend and should not
  manage that backend's service lifecycle or dependencies.
- Desktop should not implement independent dependency detection, runtime asset
  provisioning, model install, migration readiness, pgvector checks, work queue
  checks, MCP Server setup, Supported Capture Hook setup, Codex configuration,
  or current local/self-hosted API Token setup. Those capabilities should live
  behind `koed-server` contracts until superseded by a dedicated enrollment
  contract.
- Any setup flow visible in Desktop should also be available through a headless
  or scriptable `koed-server` surface. Desktop may present a guided first-run
  experience, but the underlying actions should be reusable by Local Operator
  Scripts and headless installs.
- `koed-server status --json`, `doctor --json`, setup commands, runtime status,
  runtime install, model install, and future verification commands should provide
  stable machine-readable contracts for Desktop and automation.
- Desktop may provide progress UI, explanations, prompts, links to logs, and
  recovery actions, but it should treat `koed-server` results as authoritative.
- Desktop may provide package-specific defaults for its own managed local
  personal `koed-server`, such as choosing bundled-local mode for first startup.
  Those defaults should not change remote/backend targets, and they should not
  change standalone headless behavior except where the headless install is also
  identified as fresh local-personal.
- External dependency mode remains Operator-owned. If Desktop connects to or
  starts a `koed-server` configured for external dependency mode, Desktop should
  surface missing endpoint or readiness diagnostics from `koed-server` rather
  than attempting to install or manage those dependencies itself.
- Desktop credential flows should consume the current local/self-hosted
  `koed-server` setup contracts while leaving room for KOE-218's device/app
  enrollment contract. API Tokens may remain the compatibility mechanism for
  current self-hosted AI-client integrations, but Desktop should not hard-code an
  API Token-only future if enrollment becomes the accepted product flow.
- Backend LLM synthesis remains out of scope. Desktop may configure or invoke
  AI-client-backed local flows, but Koed still returns Evidence Bundles and the
  connected AI Client performs Answer Synthesis and LCM Summary synthesis.

## Consequences

Electron Desktop can evolve without becoming a second implementation of Koed
startup and setup. This keeps headless, scripted, and Desktop flows aligned and
makes failures easier to diagnose because the same `koed-server` status and
doctor contracts explain them everywhere.

New local setup capabilities should generally be implemented in this order:

```text
koed-server service/control-plane capability
  -> machine-readable CLI or API contract
  -> Desktop UI that consumes the contract
```

This may slow some Desktop-only work because new UI sometimes requires a
headless contract first. The trade-off is intentional: any capability needed for
Desktop first-run setup is also likely needed by Operators running Koed headless,
by Local Operator Scripts, by smoke tests, and by support diagnostics.

The Desktop package can still provide a polished default experience for local
personal Koed. It can manage its local `koed-server` process, show setup
progress, open logs, display health, run setup actions, guide current credential
setup, and recover from missing runtime assets. The boundary is that it asks
`koed-server` to do or report those actions rather than computing them
independently. For Team Self-Hosted, Koed-managed cloud, or other remote targets,
Desktop is a client/control surface and should not manage backend lifecycle.

The package identity proposed by the runtime provisioning work fits this
boundary: `koed` is the Electron control plane package, while `koed-server` is
the headless local control-plane package. Desktop depends on and manages
`koed-server`; it does not replace it.

If this proposal is accepted, the KOE-217/KOE-243 implementation must update
`docs/service-sequence-overview.md` when service ordering and boundaries change.
This ADR-only proposal does not update the sequence overview by itself.

If this proposal is not accepted, the Electron implementation should explicitly
document which setup and diagnostic responsibilities are Desktop-only, how they
stay consistent with headless `koed-server`, and how Operators can perform the
same setup without Desktop.
