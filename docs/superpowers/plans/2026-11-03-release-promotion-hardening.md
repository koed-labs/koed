# Release Promotion Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Reduce release promotion failures caused by npm propagation and temporary disk pressure without relaxing verification.

**Architecture:** Bound registry polling, preserve fail-closed identity checks and publication ordering, and delete post-publication asset downloads after verification. Read back npm tags after writes while acknowledging that this cannot prevent concurrent changes.

**Tech Stack:** Node.js, node:test, GitHub Actions, npm registry.

**Spec:** Approved design in conversation: bounded candidate polling; immediate identity mismatch failure; reduced verification disk use; bounded tag readback; tests, documentation, patch changeset. Authenticated recovery and external writer coordination are out of scope.

## Global Constraints

- No release mutations or workflow reruns while developing.
- Preserve full asset inventory and byte verification and existing promotion ordering.
- Preserve fail-closed handling of identity mismatch and registry errors.
- Do not claim tag readback prevents concurrent writer races.

## Review Focus

- Missing version followed by visibility must not republish.
- Persistent absence must time out without weakening checks.
- Returned wrong identity must fail immediately.
- Disk cleanup must occur after hash success and on failures.
- Tag readback must detect persistent stale state without masking concurrent-writer risk.

### Task 1: Candidate visibility

**Files:** `scripts/release-promotion-adapter.mjs`, `scripts/release-promotion-adapter.test.mjs`.

- [ ] Add deterministic tests for missing then present, exhaustion, wrong identity, registry error and one publish only.
- [ ] Run tests and verify the new tests fail for the intended reasons.
- [ ] Poll only after publish on missing registry metadata, with bounded attempts and injectable delay; verify returned metadata immediately.
- [ ] Run adapter tests and confirm they pass.

### Task 2: Post-publication disk usage

**Files:** `scripts/release-promotion-adapter.mjs`, `scripts/release-promotion-adapter.test.mjs`.

- [ ] Test multiple published assets, hash failures and cleanup; assert assets are not all retained together.
- [ ] Verify tests fail, then delete each post-publication asset after its digest is verified, including failure cleanup; preserve complete inventory verification.
- [ ] Run adapter tests and confirm they pass.

### Task 3: Tag readback and documentation

**Files:** `scripts/release-promotion-adapter.mjs`, `scripts/release-promotion-adapter.test.mjs`, `docs/release-promotion.md`, `.changeset/`.

- [ ] Test stale then correct tags, bounded exhaustion, registry errors, and promotion ordering using injected readers and sleep.
- [ ] Verify tests fail, then implement bounded tag readback where supported without weakening downgrade protection.
- [ ] Document retry bounds, partial-publication outcomes, and external-writer race; add approved patch changeset to the appropriate release package.
- [ ] Run focused release tests, formatting, lint and relevant builds; record any limitations. Request independent review before opening a draft PR.
