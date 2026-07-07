# Commercial Feature Boundary

This document records the launch recommendation for Koed's public license,
self-hosted capability boundary, hosted-only services, and managed add-ons.

## Recommendation

Keep the public Koed distribution under `AGPL-3.0-only` for the Team SaaS
launch, with separate commercial licenses available from Koed Labs for
organizations that need different terms.

Do not make the first Team launch source-available-only, closed-core, or
open-core by hiding core Team memory behavior behind private modules. The public
product should remain useful and honest: local Personal Memory, private VPS,
and Team Self-Hosted should work as real deployments rather than demos.

Koed Labs should charge for managed convenience, hosted infrastructure,
collaboration operations, enterprise controls, support, and managed services,
not for trapping user memory data in Koed Cloud.

## License Options Considered

| Option                         | Tradeoff                                                                                                                                  | Launch decision                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| AGPL-3.0-only                  | Strong network copyleft; clear source-sharing expectation for modified network services; some companies block AGPL use.                   | Keep for public launch.                                                               |
| AGPL plus commercial licensing | Preserves public AGPL rights while giving organizations a route to proprietary/internal terms. Requires contributor licensing discipline. | Use as the launch path.                                                               |
| MIT or Apache-2.0              | Easiest adoption and lowest legal friction, but allows proprietary hosted forks with no source contribution obligation.                   | Do not switch before Team launch. Revisit only as an explicit company-level decision. |
| Source-available license       | More commercial control, but weaker open-source posture and higher trust cost.                                                            | Do not use for the main public distribution at launch.                                |
| Open-core private modules      | Can monetize features directly, but risks making self-hosted Team confusing or intentionally incomplete.                                  | Avoid for core Team memory behavior.                                                  |

This is not legal advice. Any license change must be reviewed separately before
it is applied to the repository.

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

- commercial license terms;
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

Non-trivial external contributions should require contributor terms that let
Koed Labs continue the AGPL plus commercial-license model. Without that,
commercial licensing becomes inconsistent across contributed files.

Documentation should describe deployment capability honestly:

- local Personal Memory and Team Self-Hosted are self-operated modes;
- Koed-managed cloud is a managed service;
- managed add-ons are conveniences or enterprise services, not hidden
  prerequisites for core memory ownership;
- commercial licenses change legal terms, not the underlying Memory ownership
  model.

## Follow-Up Triggers

Create follow-up implementation or documentation tickets if any of these change:

- the repository license changes from `AGPL-3.0-only`;
- Koed Labs introduces a source-available or closed commercial module;
- Team Self-Hosted loses functionality that this document treats as core;
- a hosted-only service becomes required for basic Team memory operation;
- contributor terms or public contribution policy changes;
- enterprise customer requirements force a permissive-license or dual-license
  revision.
