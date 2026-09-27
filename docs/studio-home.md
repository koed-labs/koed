# Koed Studio Home

Koed Studio is a separate experimental interface for Personal workflows.
The existing `apps/desktop` application remains unchanged.
The first slice reads real Koed data and does not start AI work or approve requests.

## Application boundaries

The React Home screen serves both Electron and a local browser.
A gateway, a small server between the screen and Koed, reads the existing Personal API.
The gateway keeps the API Token outside browser code and returns a bounded view of authorized data.

The gateway listens on the loopback interface only.
It is a local, single-operator preview, not a hosted multi-user web application.
Local processes can read the preview without a separate browser login.
Use it only on a trusted, single-user machine.
Cloud deployment requires browser authentication, user isolation and an approved remote API contract.
Do not expose this preview through a public tunnel or reverse proxy.

Electron uses a separate application name and configuration directory.
It starts its own gateway on an available local port.
It neither starts nor stops the Koed backend.
The browser and Electron therefore use the same Home data contract without sharing desktop configuration.

## First slice

Home surfaces workflow invitations, not captured-history results.
Managed execution states and pending requests can supply factual status cards.
Each card has an explicit workflow destination. Until that destination is wired,
its action is unavailable rather than opening a captured-content viewer.
The attention scan is bounded, so coverage warnings remain visible when data is incomplete.
An unavailable backend is not an empty workspace.
An authorization failure clears the previous Home data.

Captured-content drawers are not mounted from Home or sidebar Chats.
Home does not generate an AI briefing or claim to cover all events since the last visit.
New-conversation setup and approval submission remain outside this slice.

## Synthetic workflow demo

Open `http://localhost:43110/?demo=1` for the separate interactive demo.
The Demo data indicator distinguishes it from the live Home preview.
Its fictional records illustrate chat continuation, collaborative discussion,
agent decisions, work review and a personalised before/after change briefing.
Destinations open in the main working area, never a captured-memory drawer.

Demo messages, decisions and review outcomes are local simulation only.
The demo does not mount the live Home data reader, call Koed APIs, launch agents
or write to the database. In-memory changes reset when the page reloads or the
demo is reset. These screens illustrate workflows, not completed integrations.
Use the live-preview link to leave the demo.

## Prototype separation

The original design workspace is `koed-studio-prototype`.
Preserve the imported skin, navigation names and page layout.
Limit interface changes to real data, loading states, errors and unavailable actions.
Discuss any wider visual or workflow changes with the user before implementing them.
The import contains its screens so future page work can reuse the design.
Only Home is served by the integration gateway.
The active layout does not mount the synthetic workspace provider.

`apps/studio/prototype-baseline.json` records source hashes for the imported prototype.
Use this baseline to compare later design changes before importing them.
Never overwrite integrated files with an entire new prototype export.
Keep Collaborative changes in the design workspace until their page is selected for integration.

## Follow-up work

See [Home wiring plan](studio-home-wiring-plan.md) for the element-by-element audit,
reuse boundaries and acceptance checks. Implementation tasks are tracked in `TODO.md`.

Define a paginated, owner-scoped attention endpoint before removing partial-coverage warnings.
Connect conversation creation and request responses through their existing authorization checks.
Define a per-user seen marker before labelling results as unread across devices.
Add automatic recommendations only with evidence, freshness, dismissal rules and a processing budget.
Prepare before/after project changes and per-user relevance separately from rendering Home.

The Home page uses existing Koed routes and does not alter database tables or synthesis boundaries.
The local adapter is not a replacement for API authorization.
Each backend request must still authenticate with the configured Personal API Token.
