# Personal Agent Role Templates

## Purpose

A role template is a reviewed starting point for a Personal Agent's identity
and working habits. It is not a tool permission, a model setting or project
knowledge. Users can start from a template and edit their agent's instructions.

The catalogue belongs in this repository. A separate GitHub repository is not
needed for the initial implementation. Git provides review and version history;
the database serves published versions without a live GitHub dependency.

## Publication Contract

Publication is an explicit Local Operator Script operation, not a browser or
agent-facing write route. It validates the catalogue before writing it.

Each published template has a stable ID and version. Re-publishing identical
content is safe. Reusing a published ID and version with different content must
fail. A content change requires a new version. Source review should cover both
the instructions and the metadata used to suggest roles.

Source files live in `agent-role-templates/<id>/template.json` and `soul.md`.
After applying the additive catalogue migration, a Local Operator can publish
with the existing database connection supplied through
`KOED_ROLE_TEMPLATE_PUBLISH_DATABASE_URL`:

```sh
pnpm --filter @koed/db personal-agent-role-templates:publish
```

The initial publisher accepts loopback database hosts only. Do not put a
credential-bearing database URL into documentation, chat or source control.
Publishing into a hosted database needs a separately reviewed deployment path.

The read API is `/v1/personal-agent-role-templates`. Studio accesses it through
its authenticated local gateway at `/studio-api/personal-agent-role-templates`.

An authenticated User can browse the published catalogue. A catalogue read does
not grant access to another User's agents, instructions or work history.

## Agent Creation

The existing creation form suggests relevant templates from the entered role.
Suggestions do not run an LLM and do not change instructions automatically.
Selecting a suggested role explicitly loads its template and opens the preview.
Typing alone does not apply a template. Replacing edited instructions requires
confirmation. The saved instructions remain an independently editable copy.

The saved identity version records the source template ID and version alongside
its independently stored instructions. The server validates that the referenced
template version exists. Provenance means the instructions started from that
template; it does not claim the User's edited copy is identical to it.

Name, avatar and model changes must preserve both the instructions and their
provenance. Publishing a new template version must not update existing agents.
An automatic template-upgrade service is outside this implementation.

## Content Boundaries

Templates contain responsibilities, communication preferences, quality checks,
expected outputs and conditions for asking the User before proceeding.

They must not contain credentials, grant permissions, select a model or embed
private project context. Instructions cannot override runtime authorization.
Authorized Personal Memory and verified project context remain separate inputs
at execution time. No backend LLM synthesis is introduced.

## Validation Gates

The first catalogue contains Backend Engineer, Frontend Engineer, Code Reviewer,
Product Manager, Data Architect and Researcher. Role matching is deterministic;
it suggests an order without applying instructions automatically.

- Publication validates all records and rejects conflicting immutable versions.
- Saving an agent validates provenance and retains the edited instruction copy.
- Later catalogue publication leaves existing agent versions unchanged.
- Unrelated identity edits preserve instructions and provenance.
- Catalogue access is authenticated; publication is not exposed to the browser.
- Existing agents without template provenance remain readable and editable.
- Applying a template does not change the chosen model or permissions.

The PostgreSQL integration test uses `KOED_ROLE_TEMPLATE_TEST_DATABASE_URL` only
to create and remove a uniquely named temporary database. It does not migrate
the configured application database:

```sh
pnpm exec vitest run packages/db/src/personal-agent-role-template-publication.integration.test.ts
```

Without that environment variable, the database integration test is skipped.
Unit tests do not replace this migration and persistence check.

The local app must not be restarted or migrated while a User is testing another
feature. Validate first against an isolated database, then activate the catalogue
in a coordinated local restart.

## Local Activation

On September 23, the local database was backed up before migration 0047 and
publication of the six initial templates. API and Studio were rebuilt and
restarted. Readiness checks passed, including migration readiness. Browser
validation confirmed catalogue loading, Role suggestions, canonical role
selection, preview and explicit application to the editable instructions.
Custom roles remain allowed; selecting a suggestion does not overwrite a soul.

## Catalogue availability

Studio shows a clear status and Retry when the published catalogue is empty or its request fails. The deployment must publish the reviewed catalogue using the existing Local Operator Script; Studio does not create placeholder templates or publish from the browser. A role search can suggest a related available title: for example, Project Manager currently matches the reviewed Product Manager template. The User explicitly chooses the title to apply.
