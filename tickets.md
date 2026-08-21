# Tickets: Unified privacy-safe Team sharing

Build one typed, asynchronous, privacy-gated Team-sharing workflow for Captured Sessions and Personal Notes while preserving the distinct deliverables of incoming `main` and the current branch. The source design is documented in `PLAN.md`.

Work the **frontier**: any ticket whose blockers are all done. Tickets are listed in dependency order. This merge includes a wide contract cutover, so all tickets share the merge integration branch and the final ticket owns the complete green-build promise.

## Define the v5 Share Intent and source-strategy boundary

**Status:** Done.

**What to build:** Every sharing entry point negotiates collaboration contract v5 and uses one intent that binds typed source identity and capabilities, destination, mode, fidelity, a concrete activation representation, Curated Memory consent, preview, authority, and idempotency. Source-specific preparation is isolated behind a small boundary without creating a second workflow owner.

**Blocked by:** None — can start immediately.

- [x] Backend capabilities, local-edge commands, Desktop requests, persisted projection envelopes, and fixtures advertise and require collaboration contract v5.
- [x] A v4/v5 mismatch is rejected before intent or authority data is consumed; backend-newer, edge-newer, and stale persisted-envelope tests fail closed with bounded errors.
- [x] Captured Session and Personal Note source references and reviewed source capabilities are explicit and required for new preview, approval, command, replay, and durable-operation bindings.
- [x] Consent uses maximum fidelity plus a separate Curated Memory choice; selected/allowed-representation fields and candidate-session special cases are not part of the target contract.
- [x] One concrete activation representation identifies the reviewed layer and is bound into the candidate hash, preview hash, Action Grant, command, replay checks, and Pending Share.
- [x] The activation representation must belong to the intersection of source capabilities, the owner's consent ceiling, and current Team and Workspace policies.
- [x] Canonical Action Grant scope and request hashes change when the source, source capabilities, destination, mode, fidelity, activation representation, Curated Memory choice, preview, expiry, or mutation identity changes.
- [x] A reused mutation or authority reference with different bindings fails closed.
- [x] Personal Note validation requires source capabilities `{memory_events}`, snapshot mode, Memory Event fidelity, no Curated Memory, revision 1, and exactly one matching Memory Event.
- [x] Captured Session validation continues to support snapshot, continuous, provenance-valid source capabilities, cumulative fidelity, and separately authorized Curated Memory.
- [x] Source strategies may prove and prepare exact owner material but cannot publish Team access, choose privacy policy, or own lifecycle transitions.
- [x] Focused shared-contract, approval-policy, Action Grant, and source-validation tests pass.

## Compose the privacy and typed-source migration lineage

**Status:** Done.

**What to build:** Operators can migrate through the incoming privacy baseline and then add the branch's typed-source and Personal Note state without duplicate migration numbers, references to removed columns, or dishonest privacy provenance.

**Blocked by:** Define the v5 Share Intent and source-strategy boundary.

- [x] `0033_fixed_scarlet_witch.sql` is restored byte-for-byte from incoming `main`, including its original lack of a final newline.
- [x] The incoming selective-PII migration remains the `0034` migration and retains its privacy, fidelity, retry, and provenance semantics.
- [x] The incompatible branch `0034` is replaced by a generated `0035` containing only the branch delta against the privacy schema.
- [x] Typed-source columns and constraints coexist with fidelity, sanitized-preview, classifier, content-policy, retry, and representation-provenance columns.
- [x] Personal Note rows require a standalone revision-one Memory Event source and cannot claim replica or Conversation Source identity.
- [x] Captured Session rows require the applicable owner-private replica and source identity.
- [x] The migration journal and snapshots are regenerated mechanically rather than conflict-marker merged.
- [x] A blank database migrates successfully to the combined schema.
- [x] Migration smoke passes from the `0033` boundary through incoming `0034` and the new `0035`.
- [x] The documented internal-alpha handling of legacy unsanitized Team-sharing rows remains fail-closed.
- [x] The selective-PII ADR identifies incoming migration `0034`, not `0030`, as the internal-alpha baseline.

## Run Captured Session sharing through one privacy-gated Pending Share

**Status:** Done.

**What to build:** An owner can share a Captured Session through one durable asynchronous workflow. The Team receives no access until exact source preparation, privacy filtering, Team-safe representation materialization, and publication all complete.

**Blocked by:** Define the v5 Share Intent and source-strategy boundary; Compose the privacy and typed-source migration lineage.

- [x] Owner acceptance always creates and returns a durable Pending Share, whether the reviewed source is already synchronized or still needs preparation.
- [x] The Pending Share reproduces the exact reviewed manifest and source revision before privacy work begins.
- [x] Exact source remains owner-private and uses the correct replica, relationship, device, and provenance bindings.
- [x] The privacy target binds the exact source preview, manifest, classifier generation, and effective content-policy hash.
- [x] Acceptance, durable claim, and publication each re-resolve current access, consent, source capabilities, Team and Workspace policy, classifier safety, and provenance through one canonical resolver.
- [x] A valid Action Grant is required at acceptance; later Action Grant expiry does not cancel an otherwise authorized durable operation, while consent or Share expiry before publication stops it.
- [x] Only a complete ready sanitized derivative can produce Team representations; owner-private staging is never a fallback.
- [x] Initial activation waits for the reviewed activation representation, not every layer under the consent ceiling; other effective layers may materialize independently when their complete source artifacts exist.
- [x] Workspace access remains `none` throughout source preparation and privacy filtering.
- [x] Publication atomically makes the sanitized representation, Share Grant, companion scope, lifecycle event, and Workspace visibility available.
- [x] A transient source or Privacy Service outage persists retry state and exposes no plaintext diagnostic data.
- [x] A deterministic schema, authority, or provenance mismatch fails closed without publishing a grant.
- [x] Desktop review, approval, progress, and completion operate against the unified contract.
- [x] End-to-end API, repository, worker, Desktop, and deterministic fixture tests pass for a Captured Session share containing contextual PII and a credential-shaped secret.

## Run Personal Note snapshots through the same privacy pipeline

**Status:** Done.

**What to build:** An owner can share one immutable Personal Note as sanitized Team Memory without creating a replica, a sync relationship, or a separate materialization workflow.

**Blocked by:** Run Captured Session sharing through one privacy-gated Pending Share.

- [x] Personal Note review binds the owner-authored Note, its projected Memory Event, logical Memory identity, revision-one hash, and one-item manifest.
- [x] The owner can choose a writable Team Workspace and Share name but cannot select continuous mode, another fidelity, or Curated Memory.
- [x] Acceptance creates the same durable Pending Share shape and processing phases used by Captured Sessions.
- [x] Source preparation creates a standalone encrypted owner artifact and no replica or Cross-Identity Sync relationship.
- [x] The exact Note text is classified through the generic privacy pipeline before Team materialization.
- [x] A Note containing contextual PII or a credential remains exact in Personal Memory and appears only with typed placeholders in Team Memory.
- [x] Privacy outage or malformed classifier output leaves the Note pending or failed closed with Workspace access `none`.
- [x] The Team representation is a single Memory Event snapshot at source revision 1.
- [x] The Personal Note source capability remains exactly `{memory_events}` at preview, acceptance, claim, publication, recall, and export, so generic cumulative fidelity logic cannot produce leaves or rollups.
- [x] Personal Notes cannot acquire Conversation Source Access or fidelity replacement.
- [x] Owner history, rename, revoke, Team recall, and Desktop interaction tests pass without a Personal Note-specific publication shortcut.

## Replace fidelity through the Pending Share pipeline

**Status:** Done.

**What to build:** An owner can change an active Captured Session Share's maximum fidelity or Curated Memory consent without bypassing privacy filtering or making the existing safe representation disappear prematurely.

**Blocked by:** Run Captured Session sharing through one privacy-gated Pending Share.

- [x] Replacement uses a fresh preview, consent, authority binding, mutation identity, and expected Share Grant version.
- [x] During an ordinary replacement, the current representation remains readable while source preparation, privacy filtering, and embedding work are pending.
- [x] Prior content remains readable only for an ordinary replacement under unchanged authority, consent, policy, classifier safety, and provenance.
- [x] Access or authority loss, consent expiry or revocation, policy invalidation, classifier safety invalidation, or invalid provenance withdraws affected protected content immediately, even when replacement work is pending or fails.
- [x] Increasing fidelity or enabling Curated Memory requires step-up review; reducing fidelity uses native review.
- [x] Every newly authorized layer receives its own complete sanitized derivative and never falls back to a finer layer.
- [x] A replacement is published atomically and advances the Share Grant and realtime fidelity state exactly once.
- [x] Transient failure is retryable without widening authority or invalidating the prior representation.
- [x] An ordinary deterministic replacement failure under still-valid authority leaves the prior authorization intact and reports a safe lifecycle code; an authority or safety failure does not.
- [x] Concurrent replacement, revoke, policy change, classifier-generation change, and replay races fail closed or converge idempotently.
- [x] Personal Note shares reject fidelity replacement.
- [x] Repository, high-risk approval, local-edge, realtime, and Desktop replacement tests pass.

## Preserve Pending Share controls, views, and realtime lifecycle

**Status:** Done.

**What to build:** Owners and Team members see one consistent lifecycle across both source kinds, including restart-safe controls and realtime updates, without exposing Team content before activation.

**Blocked by:** Run Captured Session sharing through one privacy-gated Pending Share; Run Personal Note snapshots through the same privacy pipeline; Replace fidelity through the Pending Share pipeline.

- [x] Owner views distinguish source preparation, privacy filtering, publishing, attention-needed, terminal failure, activation, and revocation using bounded safe status data.
- [x] Retry resumes the durable operation from its authoritative phase and does not duplicate grants, companions, representations, or outbox events.
- [x] Revoke before activation prevents later publication and removes the operation from the active frontier.
- [x] Revoke after activation invalidates Team authority and follows existing retention behavior.
- [x] Rename changes only owner-selected Share metadata and never source identity or privacy bindings.
- [x] Pause and resume affect future continuous Captured Session revisions while retaining the last complete representation only while its authority, consent, policy, classifier safety, and provenance remain valid.
- [x] Protected owner and Team views, recall, expansion, and export re-resolve current authority and policy rather than trusting preview-time or publication-time intersections.
- [x] Personal Note views expose rename and revoke but not continuous-update or fidelity controls.
- [x] Realtime events use fidelity and Pending Share vocabulary consistently and cannot make a pending grant appear Team-visible.
- [x] Owner history is read-only and does not repair or create companion state as a side effect.
- [x] Restart, retry, revoke, rename, pause, resume, owner-list, Team-list, and realtime recovery tests pass.

## Preserve sanitized Conversation Source Access as a separate capability

**Status:** Done.

**What to build:** Authorized Team members can inspect or fork sanitized Captured Session source under a separate grant, while semantic fidelity alone reveals no Conversation Source and Personal Notes remain ineligible.

**Blocked by:** Run Captured Session sharing through one privacy-gated Pending Share.

- [x] Conversation Source Access requires its own active grant in addition to the active Captured Session Share Grant and current Workspace Access.
- [x] Source manifests, segments, streams, and fork snapshots read only sanitized Conversation Source artifacts.
- [x] Exact Conversation Source Journal bytes remain owner-only.
- [x] Snapshot access pins one complete sanitized frontier.
- [x] During ordinary continuous processing under unchanged authority and safety policy, access keeps the prior complete frontier readable while a later append is classified and publishes the new generation atomically.
- [x] Every frontier claim and publication, and every manifest, segment, stream, and fork read or export, re-resolves current authority, consent, policy, classifier safety, and provenance.
- [x] Access, consent, policy, classifier safety, or provenance invalidation withdraws the affected frontier immediately instead of retaining it during rematerialization.
- [x] Privacy or policy failure never partially publishes a source generation or falls back to exact source.
- [x] Stream notifications contain availability and lifecycle metadata rather than plaintext.
- [x] Revocation, retention, cursor, viewer, grant, and Workspace bindings remain fail-closed.
- [x] Personal Note shares cannot request, receive, or emulate Conversation Source Access.
- [x] Manifest, segment, stream, continuous append, fork snapshot, and revocation tests pass with PII-bearing source records.

## Compose Personal and Team embedding authority

**Status:** Done.

**What to build:** Personal and Team semantic work uses one coherent scheduling and authority model: interactive Personal work stays responsive, hosted authority remains respected, and Team vectors are reused or recomputed only from the final authorized sanitized input.

**Blocked by:** Run Captured Session sharing through one privacy-gated Pending Share; Run Personal Note snapshots through the same privacy pipeline.

- [x] Interactive Personal embedding requests retain their supported request budget, while background work uses the branch's bounded request size.
- [x] Hosted Personal semantic authority is consulted before local Personal inference and imported artifacts are validated before use.
- [x] A Team-safe input byte-identical to the accepted Personal input reuses the compatible vector under the authorized owner and Team boundary.
- [x] A changed sanitized input receives one Team-safe embedding and does not reuse the Personal vector.
- [x] Grant-scoped vector rows preserve indexed authorization and revocation even when computation is reused.
- [x] Cache and equality lookups cannot cross owners or Teams or expose a plaintext correlation oracle.
- [x] Embedding provenance binds source content, final input, model artifact, tokenizer, transform, dimensions, pooling, normalization, and version.
- [x] Transient Team embedding failure persists retry state and does not publish an incomplete representation.
- [x] Personal classification, owner-private source, sanitized Team material, and Team representation key boundaries remain distinct.
- [x] Personal Note priority, hosted import, unchanged-input reuse, changed-input inference, retry timer, and revocation tests pass.

## Contract the legacy sharing model and validate the merge

**Status:** Done.

**What to build:** The repository contains one sharing model, no conflict remnants, current documentation, coherent runtime configuration, and a complete green validation result suitable for review.

**Blocked by:** Replace fidelity through the Pending Share pipeline; Preserve Pending Share controls, views, and realtime lifecycle; Preserve sanitized Conversation Source Access as a separate capability; Compose Personal and Team embedding authority.

- [x] Legacy selected/allowed-representation commands, fields, helpers, fixtures, and compatibility branches are removed from active contracts and implementation.
- [x] The concrete activation-representation binding remains consistent across candidates, previews, Action Grants, Pending Shares, publication, replay protection, and audit after legacy consent fields are removed.
- [x] Collaboration contract v5 is the only accepted combined protocol and incompatible v4 envelopes fail closed throughout capability negotiation and transport fixtures.
- [x] Representation-change action names are replaced consistently by fidelity-change vocabulary in code, approvals, realtime events, fixtures, and documentation.
- [x] Exact-owner, source-content, sanitized-content, privacy-policy, classifier, and embedding-input hash names are used consistently.
- [x] Runtime and deployment configuration includes the incoming Privacy Service and preserves the branch's unrelated Desktop and local-runtime behavior.
- [x] Generated migration artifacts contain no conflict markers and match the final schema.
- [x] The incoming `0033` checksum is unchanged, and migration documentation names the actual `0034` selective-PII baseline.
- [x] Deterministic Team fixtures cover both source kinds and assert the privacy, authorization, revoked, stale, and retained-knowledge truth boundaries.
- [x] Security, service-ordering, Shared Memory, Conversation Source, migration, Desktop, and configuration documentation describes the unified flow.
- [x] Existing changesets remain accurate for selective PII protection, Personal Note sharing, and other user-visible branch behavior.
- [x] No merge conflict markers or unmerged paths remain.
- [x] Formatting, linting, typechecking, migration smoke, focused package tests, Electron interaction validation, deterministic Team fixture validation, and the full CI-equivalent suite pass.
- [x] The final review confirms that exact Personal content cannot reach Team rows, vectors, evidence, exports, responses, logs, or failure diagnostics.
- [x] Race coverage proves the intended distinction between Action Grant expiry after acceptance, consent or Share expiry before publication, and immediate withdrawal after authority, policy, classifier-safety, or provenance loss.
- [x] Those expiry and invalidation races are exercised during source preparation, privacy filtering, embedding, publication, continuous frontier advancement, protected reads, and exports.
