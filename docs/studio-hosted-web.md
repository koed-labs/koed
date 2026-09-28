# Hosted Studio web entry point

Koed can serve the Studio static export at `/studio/` on the same origin as its hosted API. This keeps browser sign-in, the `cm_session` cookie, and the existing browser write protections on one origin. A User opens the selected Koed backend address with `/studio/` appended.

## Deployment

The API image builds `@koed/studio` with `NEXT_PUBLIC_KOED_STUDIO_HOSTED=1`, which sets the Next static export's base path to `/studio`. The image copies that export to `/app/studio` and sets `KOED_STUDIO_STATIC_ROOT=/app/studio`. The API serves `/studio` and `/studio/*` only when that root is configured. API routes such as `/auth`, `/me`, `/v1`, `/health`, and `/ready` remain API routes.

The default Studio build has no base path. Desktop continues to serve that build from its loopback gateway. The loopback gateway's Personal API Token and local filesystem operations are not exposed by the hosted static route.

## Session and execution boundaries

The hosted page uses the backend's existing browser session for `/me` and authorized Team navigation. It does not store a Personal API Token or a Personal Device credential in browser storage. A signed-in browser can request only the operations authorized for that User by the backend. Team membership does not grant access to another User's Personal Memory.

Agent execution remains on the assigned local runner. The hosted API coordinates durable commands; it does not gain the runner's AI Client credentials or local Project paths. A device listed as an eligible execution target is not necessarily online or ready. Studio must distinguish accepted Pending commands from completed execution and report Project or AI Client readiness failures from the selected runner.

For a hosted User session, `/v1/managed-conversations/launch-options` lists eligible Personal Devices, AI Client choices, and Project ID/name summaries. It exposes neither device credentials nor Project paths. A browser start selects `targetDeviceId` and either a Project or **No Project / Standalone**. The authority persists a deferred start assigned to that device and returns HTTP 202. The local runner discovers the assigned start on recovery or command wake, checks its AI Client and, for a Project start, the local Project, then prepares its runtime binding and acknowledges readiness. For a standalone start, that runner creates an independent workspace under its own Koed home; the browser supplies no filesystem path. A mismatch or missing local dependency fails the start without moving it to another device.

When a User cancels a new Conversation before its assigned runner claims the start, the backend atomically cancels the pending start and any following queued commands. The execution becomes stopped without a provider thread. A concurrent runner claim takes precedence if it commits first; Studio reports the persisted command state and offers the appropriate running control. The runner's runtime-binding acknowledgement is fenced to the exact execution generation and assigned device.

The browser UI's Team navigation and the Desktop Studio gateway are separate integration paths. In production Desktop, the Studio window's loopback gateway can call one fixed `collaboration.load` operation through the existing collaboration broker. The gateway exposes a restricted, uncached snapshot containing connection state and authorized Team navigation. It does not expose device credentials, the Personal API Token, or a general broker command proxy. Revocation or disconnection clears the projected Team list. The standalone Studio preview has no such endpoint.

The Studio Settings page uses explicit, CSRF-protected loopback actions for the existing broker's connect, reconnect, and disconnect operations. The gateway returns a restricted Team projection after each action and clears Team data on disconnect or revocation. Enrollment and switch remain in the current broker flow. Cross-device managed Conversation controls are tracked in Ticket 03's integration ledger.

## Partial Agent replies

Studio displays partial Agent text from owner-scoped encrypted runtime output. Provider turn and item IDs reconcile this text with saved history without showing duplicate replies. If an accepted turn has an uncertain outcome, keep its encrypted partial text and show **Partial response · outcome uncertain** after reload. This text is not a completed reply. Studio does not automatically resend the prompt. Known completion, interruption, cancellation, or an explicit session end retires or reconciles transient output through the existing managed authority.
