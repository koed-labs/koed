# Commercial Feature Boundary

This document records Koed's public-license decision, self-hosted capability
boundary, hosted-only services, and managed add-ons.

## Recommendation

Distribute the public Koed repository under the Apache License 2.0
(`Apache-2.0`).

Apply Apache-2.0 to the Koed repository contents and repository history.
Existing AGPL grants remain valid; Apache-2.0 is an additional license grant for
versions previously distributed under `AGPL-3.0-only`.

Do not make the first Team launch source-available-only, closed-core, or
open-core by hiding core Team memory behavior behind private modules. The public
product should remain useful and honest: local Personal Memory, private VPS,
and Team Self-Hosted should work as real deployments rather than demos.

Apache-2.0 permits proprietary modifications and hosted forks without a
source-publication obligation. Koed's commercial differentiation therefore
comes from managed convenience, hosted infrastructure, collaboration
operations, enterprise controls, support, and managed services, not from a
copyleft requirement or trapping user memory data in Koed Cloud.

## License Options Considered

| Option                    | Tradeoff                                                                                                           | Decision                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Apache-2.0                | Permissive adoption with an express patent grant; allows proprietary hosted forks without source contribution.     | Use for the public repository.                                                            |
| MIT                       | Similarly permissive and concise, but without Apache-2.0's explicit patent terms and notice framework.             | Do not use; Apache-2.0 provides the preferred contributor and patent terms.               |
| AGPL-3.0-only             | Network copyleft can encourage publication of hosted modifications, but creates adoption and procurement friction. | Retain existing grants while additionally offering historical Koed code under Apache-2.0. |
| Source-available license  | More commercial control, but is not an open source license and introduces a more restrictive user trust boundary.  | Do not use for the main public distribution.                                              |
| Open-core private modules | Can monetize features directly, but risks making self-hosted Team confusing or intentionally incomplete.           | Avoid for core Team memory behavior.                                                      |

This document describes the repository's product boundary. It is not a
substitute for legal review of licensing, contributor rights, third-party
notices, trademarks, patents, or commercial agreements.

## Public Distribution

The public Koed distribution should include the core code needed for:

- local Personal Memory;
- Koed Desktop and local `koed-server`;
- MCP Server and Supported Capture Hook integration;
- private VPS/open-source self-hosted deployment;
- Team Self-Hosted backend primitives;
- Team, Workspace, membership, Workspace Access, Share Grant, retention, audit,
  entitlement, capability, device enrollment, and route-identity models;
- local/operator-managed embedding and recall infrastructure;
- backup, restore, health, readiness, and diagnostic foundations that an
  Operator needs to run Koed safely.

Feature gates in the public distribution must be positive capability gates. They
may say that a hosted service, managed add-on, or enterprise integration is not
available in this deployment. They must not make the self-hosted product
silently broken, misleading, or dependent on unavailable Koed Cloud internals.

## Team Self-Hosted

Team Self-Hosted is a deployment mode, not a paid boundary by itself.

An Operator should be able to run a Team-capable backend on their own
infrastructure using the public distribution and their own dependencies. That
deployment may integrate with the Operator's own identity provider, KMS/Vault,
backup storage, observability, and reverse proxy where supported.

Koed Labs may still sell:

- hosted and managed services;
- managed setup and support;
- hosted or managed infrastructure;
- enterprise support agreements;
- certified builds or update operations;
- managed add-ons that require Koed-operated infrastructure.

Those commercial offers should not redefine Team Self-Hosted as broken unless a
customer pays Koed Labs.

## Hosted-Only And Managed Add-Ons

The first managed/commercial boundary can include these Koed-operated services:

- Koed-managed cloud hosting and operations;
- hosted onboarding, account, and billing flows;
- WorkOS/AuthKit integration for Koed-managed cloud identity;
- SSO/SAML/SCIM and enterprise identity controls;
- managed Memory Inbox processing, storage, extraction, and file pipelines;
- hosted support/admin operations and break-glass workflows;
- managed backups, restore verification, disaster recovery, and update
  operations;
- hosted observability, alerting, and capacity operations;
- premium support and response SLAs;
- BYOK/CMEK/KMS integrations where Koed operates the managed control plane;
- customer-specific compliance, audit export, legal hold, or retention controls.

Where practical, equivalent operator-managed extension points should exist for
Team Self-Hosted without requiring Koed Labs to run the infrastructure.

## Repository And Contributor Implications

The repository should keep one coherent public implementation for core Team
memory behavior. If commercial-only service code is added later, it should be
isolated around managed operations or hosted integrations, not mixed into the
core authorization and memory model in a way that makes public review unclear.

Contributions are accepted under Apache-2.0 subject to
[CONTRIBUTING.md](../CONTRIBUTING.md). Koed Labs requires a contributor
agreement for non-trivial external contributions so authorship, patent grants,
and future licensing rights remain clear.

Documentation should describe deployment capability honestly:

- local Personal Memory and Team Self-Hosted are self-operated modes;
- Koed-managed cloud is a managed service;
- managed add-ons are conveniences or enterprise services, not hidden
  prerequisites for core memory ownership;
- commercial services and agreements do not reduce the rights granted for
  Apache-2.0 releases or change the underlying Memory ownership model.

## Follow-Up Triggers

Create follow-up implementation or documentation tickets if any of these change:

- the repository license changes from `Apache-2.0`;
- Koed Labs introduces a source-available or closed commercial module;
- Team Self-Hosted loses functionality that this document treats as core;
- a hosted-only service becomes required for basic Team memory operation;
- contributor terms or public contribution policy changes;
- enterprise customer requirements create pressure for a different public
  license, dual licensing, or closed modules.
