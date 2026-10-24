# Release Stack Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare #421 → #428 → #432 for re-review, treating the supplied response as the expected agreement, without implementing the review's deferred redesigns.

**Architecture:** Replace component KMS authentication with canonical manifest SHA-256 pins carried by trusted, versioned npm/Desktop control planes. Freeze target components before generating pins and packaging control planes. Preserve component integrity, private IPC, lifecycle ownership, filesystem defenses, and runtime bundle verification.

**Tech Stack:** TypeScript, Node 24, Electron 39.8.10, pnpm, GitHub Actions, npm, GitHub Releases, Apple signing/notarization.

**Spec:** Supplied `response-stack-429-review.md` governs scope; supplied `stack-429-plan.md` revision 3 supplies review findings. This document is a proposed plan, not approval to execute or change cloud resources. Upload copies are not committed; resolved requirements are captured below.

## Local execution checkpoint

Developer subsequently confirmed the minor changeset and authorized stack pushes.
Core fixes were ported to #421, signing integration merged into #428, and shared
lifecycle adaptations merged into #432. History was preserved. Current PR checks
are authoritative for pushed heads; platform acceptance and signer-retirement
gates remain open.

Earlier checkpoint: local implementation was subsequently approved, with a pause before pushing.
The external standalone launcher extension was separately approved. Task 1 has
two local commits; Tasks 2–4 have local implementation and test coverage, but
actual candidate/platform acceptance items remain open. Task 5 is only partially
satisfied; Task 6 signer removal remains blocked on that acceptance. No stack
push, live operational change, publication or re-review readiness is claimed.
See [local evidence and unresolved gates](../../release-stack-remediation-evidence.md).
Unchecked acceptance items below must not be inferred complete from unit tests.

## Baseline and scope

Inspected 2026-10-23:

| PR   | Head                                       | Responsibility                   |
| ---- | ------------------------------------------ | -------------------------------- |
| #421 | `d5ff41430e9650b6ca388d3462a24dbeb66ebac1` | Component distribution and trust |
| #428 | `406fce68dd4f4d1b5b6e5101311354b94f5c9999` | macOS signing/notarization       |
| #432 | `71451e50086cbca4f33730c89f4fa88438d55096` | Shared Desktop/CLI lifecycle     |

Checkout matches #432. “Stack 429” is a review label, not an existing PR. Existing untracked `docs/release-stack-handoff.md` is historical and must not be overwritten or treated as current validation evidence.

### Global constraints

- Trust official npm distribution/publication chain and trusted Desktop release artifact. Hostile npm mirrors and registry-metadata substitution are out of scope. Pins do not defend against substituted control-plane packages.
- Require component/control-plane version equality. Catalog keys bind component, product version, platform, architecture, and libc where present. Missing or mismatched entries fail closed.
- Pin canonical manifest bytes, covering identity, target, runtime compatibility/ABI, archive digest, required files, and inventory. Preserve strict schema/canonical encoding checks.
- Keep `@koed-labs/server` on npm and Base/Privacy assets on GitHub Releases. Native runtimes/models remain separate; do not silently redesign their trust.
- Keep nonce, process identity, constrained IPC requests, ownership/capabilities, bundle inventory/hash verification, and `bundleDigest`. No claim of a hard boundary against arbitrary same-user code.
- Keep all current no-follow, directory-chain, inode/race, bounded archive, staging, lock, cancellation, and atomic-publication protections.
- Same-version generation recovery is not whole-release rollback. Reject generation downgrades; make no database compatibility, database restoration, or unrestricted rollback claim. No new schema/migrations or backend LLM synthesis.
- No performance shortcut or startup/status improvement claim. Investigate material regressions caused by this change; broad benchmarks remain deferred.
- Standalone checks require Node `>=24 <25`; current shell is `v26.3.1`, unsuitable for acceptance. Use CI's Node `24.13.1` or recorded supported Node 24 runtime. Electron's embedded Node is a separate tested runtime.
- Keep publication authorization disabled. Cloud mutation, key retirement, release promotion, and publication require explicit authorization outside this planning task.

### Review focus

1. Circular build input: Base contains Server code; catalog injection must never alter the component whose digest it pins.
2. Effective trust: a correct catalog sidecar must not conceal stale pins in the executable CLI or packaged Desktop copies.
3. Catalog completeness: four files are not proof of four required identities; reject duplicates, wrong targets, and missing tuples.
4. Recovery: failed trust/activation must preserve current pointer and release locks; accepted old bytes must not imply database compatibility.
5. Negative coverage: test fixtures must provide expected identities independently, not derive expectations from the potentially wrong manifest.

## Task 1 — Record trust decision and fix narrow review findings (#421)

**Files:** `docs/adr/` (new decision; allocate number using repository convention), `docs/adr/0011-standalone-koed-server-package.md`, `docs/standalone-koed-server-package.md`, `docs/running-koed.md`, `packages/koed-server/src/generation-lifecycle.ts`, `packages/koed-server/src/generation-lifecycle.test.ts`.

- [ ] Record trust assumption, npm/GitHub split, exact-version pins, and limited rollback semantics. Explicitly reconcile ADR 0011's signature/provenance and DB-compatible downgrade language with this narrower implementation; do not silently claim ADR requirements are satisfied by hashing alone. Retain its independent trusted-bootstrap requirement and bundled-fallback direction.
- [ ] Add failing activation tests: same-version Base-only → Base+Privacy generation switch succeeds; newer → older generation activation rejects; rejection leaves current-pointer bytes unchanged and a subsequent valid activation succeeds. Use same Base digest, since store rejects conflicting content at one identity.
- [ ] Run focused generation tests and confirm new assertions fail for the missing behavior/error contract.
- [ ] In `activateGeneration(paths, id, requester, capability?)`, retain downgrade protection but use generation-specific wording without `--allow-downgrade`. Do not weaken the separate package-install downgrade/migration guard, whose CLI really supports that option.
- [ ] Correct docs: activation's synthetic package manifests carry no migration metadata; this is version rejection, not database compatibility validation. Correct stale claim that production roots are empty while the KMS path still exists; final docs switch to pins in Task 6.
- [ ] Obtain read-only operational evidence whether deployed signer has `KOED_SIGNER_REHEARSAL_SHA` set. Review reports authorization was revoked; do not infer live state from repository code. Remove rehearsal exception before merge or document exact restricted reason/expiry while signer remains needed. Record unavailable cloud access as an unresolved gate.
- [ ] Rerun generation/package-runtime tests; commit narrow correction independently.

**Deliverable:** Accurate existing-path behavior/docs, explicit trust decision, direct activation tests. This task does not assert pin implementation readiness.

## Task 2 — Establish acyclic component/catalog build boundary (#421)

**Files:** `scripts/component-assembly.mjs`, `scripts/app-runtime-staging.mjs`, `scripts/build-koed-component-release.mjs`, `scripts/component-release-lib.mjs`, corresponding tests; create `scripts/component-manifest-catalog.mjs` and its tests; create shared catalog type/lookup module under `packages/koed-server/src/`.

**Consumes:** Existing `canonicalComponentManifestBytes(manifest)` and `buildComponentReleaseSet(...)`; retain canonical serializer rather than creating another encoding.

**Produces:** Deterministic `component-manifest-hashes.json`, schema-versioned with release version and exact required component/target tuples. Runtime lookup has no mutable public map or Operator-controlled production override.

- [ ] Add failing tests for deterministic output, duplicate/conflicting entries, malformed digests, wrong version, missing/extra required identity, and libc distinctions.
- [ ] Build catalog from frozen canonical manifests for Base/Privacy × Linux x64/macOS arm64; validate each manifest identity against independently declared release matrix. Use actual target measurements, not Linux-derived Electron compatibility.
- [ ] Resolve cycle explicitly: produce fixed component-runtime outputs first, freeze their archives/manifests, then generate catalog and separately build trusted control-plane outputs. Do not rebuild/rearchive Base from the later catalog-bearing Server output.
- [ ] Audit imports, runtime selection, subprocess and re-exec paths before accepting that split. Component-runtime copy must not become a trusted installer or supply production pins; catalog-less builds fail closed for component admission. If runtime execution requires catalog-bearing installer code inside Base, stop for a focused build-boundary design decision rather than accepting self-reference or excluding files from inventory.
- [ ] Add regression proving final control-plane packaging cannot change frozen component bytes, and package rebuilds do not erase catalog input. `clean-dist.mjs` removes dist; patching dist alone is not a build contract.
- [ ] Run component assembly/release/catalog tests; commit tested boundary and catalog generation.

**Checkpoint:** Build split approved 2026-10-23, including standalone boundary extension: package its trusted control-plane launcher outside frozen Base and preserve that external entrypoint across supervisor restart/re-exec. Direct Base CLI stays catalog-less. Never exclude catalog files from inventory or embed self-authenticating pins in Base. This remains the principal architectural risk, not a reason to weaken inventory verification.

## Task 3 — Admit pinned manifests through real install/reuse paths (#421)

**Files:** `packages/koed-server/src/component-verification.ts`, `packages/koed-server/src/component-store.ts`, `packages/koed-server/src/component-contract.ts`, `packages/koed-server/src/component-commands.ts`, `packages/koed-server/src/cli-implementation.ts`, test fixtures and corresponding tests; `packages/koed-server/src/desktop-component-manager.ts`; `apps/desktop/src/koed-server/privacy-install.ts`, `apps/desktop/src/cli-install/protocol.ts`, `apps/desktop/src/cli-install/ipc.ts`, `apps/desktop/src/main.ts`.

- [ ] Add failing verifier/store tests for valid pins and missing/stale pins; wrong component/version/platform/architecture/libc; changed runtime/ABI/required-file metadata with unchanged payload; noncanonical/duplicate-key manifest; changed archive and extracted file.
- [ ] Verify strict canonical manifest and independently requested identity, then compare SHA-256 against compiled catalog before archive extraction/publication. Keep archive and extracted-inventory checks unchanged. Recheck catalog on cached reuse/start, not just initial download.
- [ ] Exercise same cases through both online and offline acquisition. Offline asserts zero network calls; failures leave no published store/index/generation changes. Cached record digest cannot establish trust or override catalog.
- [ ] Remove signature requirements from CLI/IPC source contracts and file picker; replace signer-availability status with exact required catalog-entry availability. Preserve nonce/authorization and request-key constraints, cancellation/progress, and pre-start Privacy installation.
- [ ] Rename signature-specific types/status discriminants truthfully; avoid “signed” claims for hash-pinned components.
- [ ] Version stored-record format and fail closed with actionable reinstall guidance for pre-pin test stores. Confirm no published installations before relying on no migration requirement; otherwise return for explicit compatibility policy. Never silently trust old stored metadata.
- [ ] Run component, generation, IPC, bundle-tamper, filesystem/race and Desktop lifecycle regressions. Commit functional pin admission while retaining KMS infrastructure until replacement acceptance is proven.

**Deliverable:** Actual installer and runtime-reuse paths enforce pins without weakening downstream checks.

## Task 4 — Package pins and verify promotion end to end (#421; workflow integration in #428)

**Files:** `.github/workflows/release.yml`, `.github/workflows/release-desktop-assets.yml`, `.github/workflows/ci.yml`, `scripts/build-public-server-package.mjs`, `scripts/package-release-identity.mjs`, `scripts/release-promotion-adapter.mjs`, `scripts/release-promotion-lib.mjs`, `scripts/write-koed-release-artifact-metadata.mjs`, asset-validation scripts/tests; `apps/desktop/package.json`, Desktop build/signing scripts as needed.

Required DAG:

```text
reviewed SHA/version → target components frozen → complete catalog
  → npm control-plane package
  → Desktop control-plane package → Apple signing/notarization
  → actual artifact verification → authorized candidate/promotion
```

- [ ] Add failing workflow/package tests: npm cannot package in Linux matrix leg before macOS manifests exist; Desktop cannot package before complete catalog exists; recovery workflow uses same exact-version catalog/assets.
- [ ] Aggregate both targets before packaging. Preserve frozen artifacts across jobs with explicit identity/digest checks. Inject same catalog through deterministic build inputs into npm and Desktop; account for Desktop's workspace rebuild. Do not modify sealed/notarized app afterward.
- [ ] Test promotion against exact required tuple set, not manifest filename count. Reject duplicate Linux tuples replacing missing macOS tuples and catalog/asset version mismatches.
- [ ] Verify actual npm tarball metadata, bin contract, inventory/SRI and embedded catalog. Install outside checkout and invoke its effective verifier; sidecar correctness alone is insufficient because public CLI is bundled into `vendor/control-plane.js`.
- [ ] Verify effective packaged Desktop catalog and executable copies against npm catalog and frozen manifests. Preserve signed-child → final runtime inventory → outer app seal ordering.
- [ ] Preserve streaming downloads, immutable uploads, npm candidate checks/provenance, latest anti-downgrade, and approval variables. Candidate retrieval must verify downloaded bytes against expected integrity; do not broaden claim to hostile-registry defense.
- [ ] Run actual pre-promotion verification on release candidate without granting public publication. Demonstrate both good install and tamper rejection through this gate, not only mocked adapter tests.
- [ ] Commit workflow/promotion integration separately; carry #428-specific signing integration on #428 after #421 boundary stabilizes.

## Task 5 — Acceptance before retiring KMS verification

**Files:** Existing component/package/packaged smoke tests and CI validation configuration; evidence record under docs with sanitized artifact hashes and run links.

- [ ] Select supported Node 24 and rerun previously failing script test. Record exact runtime and commands; prior Node 26 failure is not proof of a code regression or success under Node 24.
- [ ] Build fresh Base/Privacy artifacts for both declared targets and catalog-bearing npm/Desktop packages. Record commit, version, catalog digest, artifact digests, runtime/ABI, cache/native/model provisioning conditions.
- [ ] Outside checkout, install packed npm CLI; install online and offline components; activate; start Personal and applicable Team paths; inspect health; stop/restart/shutdown. Demonstrate manifest/archive/inventory tampering and missing/wrong pins reject without fallback.
- [ ] Run packaged macOS acceptance: Privacy installation before daemon start, successful provisioning where claimed, same-version recovery after injected restart failure, Desktop/CLI adoption, external stop, competing starts, independent CLI denial, adopted-supervisor quit behavior. Negative Team smoke alone is not positive Privacy/Team acceptance.
- [ ] Verify #428 signed/notarized artifacts and packaged CLI/bundle checks after catalog injection. Keep relocation, helper/fuse, uninstall, fresh native provisioning and clean-Mac acceptance explicitly classified as merge or release gates; do not silently mark deferred checks complete.
- [ ] Run applicable Linux x64 checks if Linux artifacts remain in catalog/promotion matrix. Parked validation must become explicit unresolved support/release gate, not a blanket pass. CUDA acceptance remains separate when required by native release matrix.
- [ ] Investigate material startup/status regressions attributable to pins/build changes; no broad benchmark project and no skipped integrity passes.

**Gate:** Do not remove KMS verification until pin tests and actual install/promotion candidate checks pass. Report outstanding acceptance honestly before requesting re-review.

## Task 6 — Remove obsolete signing path and reconcile documentation

**Files:** `packages/koed-server/src/component-trust-roots.ts`; component signature helpers/consumers; `infra/component-signer/`; `scripts/release-signing-adapter.mjs`, `scripts/component-signing-rehearsal.mjs`, signer-only tests; workflows; `docs/standalone-koed-server-package.md`, `docs/running-koed.md`, `docs/release-promotion.md`, `docs/desktop-notarization.md`, `docs/ci-validation.md`, configuration references, `TODO.md`.

- [ ] After Task 5 gate, delete unused component signatures, roots, signer implementation/adapters/rehearsal and signing-only workflow inputs/assets. Replace trust gates with catalog completeness/consistency gates, not unconditional success.
- [ ] Search for all signer-specific variables, signature suffixes, help/errors and stale rollback claims. Preserve npm OIDC/provenance, Apple credentials, unrelated KMS use, and separate legacy app-runtime provenance behavior.
- [ ] Document exact trust model, release ordering, missing-pin failure, test-store reinstall, version matching and rollback limits. Record deferred database framework, CLI IPC replacement, filesystem simplification, precomputed bundle identity and broad benchmark work in `TODO.md`, not `CONTEXT.md`.
- [ ] Inventory live signer consumers and drafts. After separately authorized operational change, revoke temporary rehearsal access, stop callers, retire signer URL/root configuration, disable service/key reversibly and retain evidence. Do not destroy key as part of code cleanup; no live-state claim without verification.
- [ ] Release-note decision before adding or omitting changesets: recommend **minor**, because trust/configuration/release pipeline behavior changes materially. Ask developer confirmation; check whether existing approved minor changesets already cover scope. No changeset decision assumed here.
- [ ] Rerun retained tests after deletions; commit cleanup separately.

## Task 7 — Repair stack and prepare re-review packet

- [ ] Keep #421 fixes on #421; update #428 from new #421, resolving catalog-before-signing DAG there; update #432 from new #428, retaining lifecycle behavior. Prefer incremental commits/merges for review continuity. If necessary history rewrite is approved, use `--force-with-lease`, then refresh all reviews/checks.
- [ ] Run cheap local checks before each push; watch resulting CI through completion. Run full release-candidate tier where touched release paths require it; lightweight green CI is not packaged acceptance.
- [ ] Refresh heads, commits, comments, review threads and checks immediately before posting responses or resolving threads. Map each review finding to commit/test/evidence or explicit agreed deferral.
- [ ] Update descriptions via repository PR template: new trust boundary, build-cycle resolution, test evidence, retained guarantees, missing acceptance, and no publication authorization. Do not reuse historical signed-lifecycle evidence as proof of new pins.
- [ ] Request re-review #421 first, then workflow/signing integration #428, then lifecycle #432. Merge only after required reviews/checks and stated merge gates; refresh next PR base/checks after each merge.

### Re-review matrix

| Finding                        | Planned resolution                                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| A: Manifest pins/KMS           | Tasks 2–6, candidate install/promotion evidence                                                             |
| B: npm platform packages       | No change; document retained npm/GitHub split                                                               |
| C: CLI replacement             | Deferred; IPC authority/lifecycle tests retained                                                            |
| D: DB/rollback                 | Task 1 tests/error/docs; broader framework deferred                                                         |
| E: Filesystem simplification   | Rejected for this stack; negative tests retained                                                            |
| F: Precomputed bundle digest   | Deferred; inventory verification and `bundleDigest` retained                                                |
| G: Benchmarks                  | Broad project deferred; introduced regressions investigated                                                 |
| Stale trust-root documentation | Task 1 interim correction; Task 6 final pin docs                                                            |
| Rehearsal authorization        | Read-only evidence plus bounded removal/retirement gate                                                     |
| Publication approvals          | Existing gates retained; explicitly decide per-publication environment approval before first public release |

## Verification commands

Run under supported Node 24. Add new catalog tests to script list. Expected result: all commands exit 0; preserve output/counts and distinguish not-run/skipped checks.

```bash
pnpm --filter @koed-labs/server build
pnpm --filter @koed-labs/server test
pnpm --filter @koed/desktop test
node --test scripts/component-release-lib.test.mjs scripts/component-distribution.test.mjs scripts/component-assembly.test.mjs scripts/build-public-server-package.test.mjs scripts/package-release-identity.test.mjs scripts/release-promotion-adapter.test.mjs scripts/release-promotion-lib.test.mjs scripts/release-promotion-workflow.test.mjs scripts/desktop-release-workflow.test.mjs scripts/ensure-release-assets.test.mjs
pnpm fmt:prettier:check
pnpm lint
pnpm --filter @koed-labs/server typecheck
pnpm --filter @koed/desktop typecheck
pnpm --filter @koed/desktop package:mac
```

These commands do not substitute for Task 5's installed-artifact and promotion evidence. No implementation tests were run while preparing this plan.

## Execution handoff

Approve scope and Task 2 build boundary before implementation. Recommend task-by-task execution with independent review at build/catalog, runtime admission and promotion boundaries: failures there could package an unusable or incorrectly trusted installer. No commits, pushes, cloud changes or implementation are authorized by this plan itself.
