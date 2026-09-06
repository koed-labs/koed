# ADR 0039: Remote Runners Use An Outbound Koed Protocol Connection

Status: Accepted.

Related decisions:

- [0007 Desktop Control Plane Consumes koed-server](./0007-desktop-control-plane-consumes-koed-server.md)
- [0008 Explorer-First Auth And Device Enrollment](./0008-explorer-first-auth-and-device-enrollment.md)
- [0015 Managed Conversation Execution And Realtime](./0015-managed-conversation-execution-and-realtime.md)
- [0016 Exclusive Execution Handoff And Fork Lineage](./0016-exclusive-execution-handoff-and-fork-lineage.md)
- [0030 Shared Durable Realtime Client Runtime](./0030-shared-durable-realtime-client-runtime.md)
- [0031 Realtime Transport Allocation And Negotiation](./0031-realtime-transport-allocation-and-negotiation.md)

## Context

A User may run Desktop and an AI Client on a laptop while a Personal or Team
authority runs on a private host, VPS, Tailscale address, tunnel, or managed
Koed backend. The remote authority must coordinate durable commands without
receiving local repository or AI Client credentials, requiring inbound access
to the laptop, or turning an SSH shell into product authority.

Koed already has device enrollment, an upstream registry, capability discovery,
explicit route policy, fenced managed execution, encrypted source replication,
durable command claims, and transport negotiation. Adding a second SSH-specific
runner protocol would duplicate those boundaries and make behavior depend on
how the host was reached.

## Decision

A remote-runner connection is always an outbound authenticated Koed protocol
connection from the runner's local `koed-server` to one enrolled backend.

The local edge stores one exact backend record with a canonical base URL,
validated deployment profile, cached capability contract, device enrollment,
credential reference, and explicit `managedExecution` route policy. Desktop
uses the same connection flow for an HTTPS domain, LAN endpoint, Tailscale
endpoint, or an Operator-created tunnel endpoint. It does not infer topology
from a hostname.

Before binding execution authority, the local edge validates:

- HTTPS outside exact loopback development;
- DNS-pinned network policy and disabled redirects;
- current capability and release metadata;
- the enrolled device credential and `managed_execution` operation family;
- explicit managed-execution route policy; and
- compatible managed Conversation and Conversation Source replication
  capabilities.

The Worker watches the protected upstream registry and enrollment state. A
validated authority change fences and replaces the current runtime service.
The runner opens outbound command and wake channels, claims only commands
assigned to its deployment and device, records the highest execution generation
seen, and acknowledges durable outcomes. Local provider, Git, source-control,
filesystem, terminal, and preview credentials remain local.

No inbound runner port is required. A disconnected runner leaves commands
durably queued or unavailable; the backend does not silently select another
runner.

### Private Network And Tunnel Use

An Operator may make the backend available through a private DNS name,
Tailscale, a reverse proxy, Cloudflare Tunnel, or an SSH local-forward. The
resulting endpoint still enters Koed as an ordinary exact backend URL and uses
normal TLS, enrollment, capability, route-policy, and request authorization.

Koed does not invoke SSH, copy SSH keys, manage `known_hosts`, execute remote
shell commands, or treat an SSH session as runner identity. Product-managed SSH
host lifecycle is a separate Personal feature requiring its own authority and
credential decision. It is not a fallback for failed Koed enrollment.

### Source Materialization

Current managed execution selects a local Project on its chosen runner. Moving
execution to another enrolled device uses the encrypted handoff/fork source and
workspace-snapshot protocol, not a renderer-directed `git clone`. A hosted
runner may materialize a repository through the source-control driver only when
its installation credential, destination root, source revision, and workspace
identity are server-selected and fenced. Until that hosted-runner mode is
advertised, clone remains unavailable rather than falling back to ambient Git
credentials.

### Endpoint And Client UX

Desktop asks for a backend URL, validates public capabilities, opens browser
enrollment, activates the returned device credential, and displays one
authoritative connection state. Reconnect uses the durable shared realtime
runtime. Personal local behavior remains available while the remote authority
is unavailable.

The UI may describe a connection as LAN, private, or hosted only from the
validated deployment record or explicit User label. It must not probe arbitrary
routes, scan the LAN, guess a backend from ports, or claim a runner is ready
from transport connectivity alone.

## Required Evidence

- Exact endpoint discovery and capability validation for loopback development,
  public HTTPS, and explicitly registered private-network targets.
- Redirect, DNS rebinding, loopback disguise, metadata target, stale capability,
  disabled policy, wrong credential family, revoked device, and backend-change
  denial.
- A local runner claiming and completing a remote-authority command while local
  provider and repository credentials remain absent from the remote backend.
- Reconnect and authority replacement without duplicate provider submission.
- Offline queue visibility and later catch-up from durable cursor state.
- Source restore, execution generation, workspace binding, and command
  assignment denial for another deployment or device.

## Consequences

- LAN, Tailscale, tunnel, private VPS, and managed Koed use one execution
  protocol and one authorization model.
- Users do not expose an inbound laptop service or install an SSH-specific Koed
  agent.
- Existing outbound enrollment and runner code remains the implementation path.
- Product-managed SSH execution and hosted repository cloning remain explicit
  future capabilities instead of hidden fallbacks.

## Rejected Alternatives

- An inbound remote-control port on each runner.
- SSH command execution as a second managed Conversation protocol.
- Copying provider, repository, or SSH credentials to the coordinating backend.
- Inferring authority from URL reachability, hostname, active socket, or Team
  Membership.
- Automatically moving a queued command to a different runner.
