# Manifest-pin remediation: local verification

## Review follow-up: current local evidence

Core remediation starts from reviewed #421 `b86f39e3257702dfca9d49ca191bab694083a706`.
Local commits `acd999b33` and `67c11c86c` repair ordinary cross-version activation,
install composition and prior-component diagnostics. `f1db8ca56` corrects remaining
component provisioning instructions. These commits have not been pushed or
propagated into #428/#432; this is not final-stack acceptance.

Node **24.13.1**, pnpm **11.1.2**, macOS arm64:

- Fresh Server build and Server suite: **68 files, 941 tests passed**.
- Root test-source typecheck (`pnpm exec tsc -p tsconfig.test.json`), Server
  typecheck, and targeted ESLint/Prettier checks passed for the additional runtime
  fixes. This is not a fresh full-stack lint or final-head CI claim.
- Actual globally installed packed npm fixture admission/tamper smoke passed:
  **1 test**. It uses synthetic components, blocks checkout imports and guards
  fetch calls. It does **not** establish native startup, two-version installed
  command acceptance, or operating-system-level offline isolation.
- Provisioning documentation regressions: **2 tests passed**, following a
  reproduced failure on obsolete signature-sidecar instructions.
- Independent read-only runtime review found no actionable issues in the added
  diagnostic-presence and cross-version authority/liveness regressions.
- `pnpm test:required-suites` passed against a new isolated PostgreSQL **17.10**
  cluster with explicit UTF8 encoding: **289 Vitest tests plus 59 Node tests**.
  Database, API, authorization, realtime, IPC, Electron UI, accessibility and
  runtime-component assembly tiers executed. The disposable server was stopped
  afterwards. No existing Personal Memory or database was used. These suites do
  not establish installed native or signed Desktop acceptance.

Fresh remote inspection found default/required checks green on the reviewed
stack heads; native/full-candidate/KMS tiers were skipped. The historical local
missing-database result below is not a current CI failure. The fresh local
required-suite result above supersedes that environment blocker, not the native
or signed acceptance gates.

**Open merge gates:** actual frozen Base/Privacy on both supported targets;
assembled-candidate verification without publication; installed online/offline
Personal and Team startup, lifecycle and cross-version flows; Linux native
acceptance; and supported signed/notarized clean-Mac Desktop acceptance. This
host reported zero valid signing identities. Complete Privacy assets, trusted
native artifact provenance, Linux-host access and signed artifacts remain
unestablished. Synthetic fixtures do not waive these gates. Component signer
cleanup remains gated on actual replacement install/candidate acceptance; no
cloud resource changes are authorized or required by source cleanup.

## Historical scope and status

The remaining sections record the earlier remediation snapshot, not current
working-tree state, final-head results or additional acceptance.

Local remediation for #421 → #428 → #432 implements ADR-0057 and the approved
external standalone control-plane boundary. This is **not** release-candidate
acceptance or authorization to publish, promote, merge, retire infrastructure,
or claim the stack is ready for re-review.

Snapshot before authorized pushes. Base commit before the replacement work: `b2dac3cf3` (Task 1 activation
wording and prerelease ordering corrections are committed locally). At this snapshot, catalog, admission, packaging and workflow changes were local working-tree changes.
No push, cloud mutation, signing rehearsal or publication was performed.

## Implemented boundaries

- Freeze Base/Privacy assets for both declared targets before building the complete
  versioned manifest catalog. Catalog-bearing standalone/npm launchers remain
  outside frozen Base; restart preserves that external entrypoint.
- Embed identical catalog data in trusted npm/Desktop control planes. Base's
  runtime copy remains catalog-less and cannot admit components by itself.
- Runtime requires canonical manifest pins and independent requested identity.
  Archive/inventory, runtime compatibility, filesystem and lifecycle checks remain.
  Linux pin identity uses the catalog's artifact glibc baseline, not host version.
- Runtime acquisition and Desktop IPC use archive + manifest, not signature input.
  Legacy component records fail closed with reinstall guidance. Existing published
  installation inventory is unverified; no migration-free rollout claim is made.
- Promotion inspects candidate catalog syntax without importing or executing
  candidate code in its credential environment. Inspection follows package-local
  ESM bindings and rejects detected mutable/reassigned catalog bindings. This is
  a generated-binding consistency check, not authentication of arbitrary JavaScript
  or proof of runtime admission. Independent packaged behavior remains mandatory.
- Desktop inspection checks actual catalog/validator imports and their validation
  call inside the asar's component store. Comment strings and unused catalog
  imports do not satisfy the check. Reinspection clears the asar header cache.

## Historical verification

Runtime: Node **24.13.1**, macOS arm64. Node 26 is outside standalone support.
Commands below assume supported Node 24 appears first on `PATH`.

| Check                                                                     | Result                                                            |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `pnpm lint`                                                               | Pass                                                              |
| `pnpm fmt:prettier:check`                                                 | Pass                                                              |
| `pnpm --filter @koed-labs/server typecheck`                               | Pass                                                              |
| `pnpm --filter @koed-labs/server test`                                    | 71 files, 938 tests passed                                        |
| `pnpm --filter @koed/desktop exec vitest run --passWithNoTests`           | 99 files, 964 tests passed                                        |
| `pnpm --filter @koed/desktop exec tsc -p tsconfig.json --noEmit`          | Pass                                                              |
| `pnpm --filter @koed/desktop exec tsc -p tsconfig.electron.json --noEmit` | Pass                                                              |
| Fresh Server build followed by `node --test scripts/*.test.mjs`           | 381 passed, 1 skipped: live database fixture needs `DATABASE_URL` |
| `pnpm test:required-suites`                                               | Blocked: `Required database suite needs DATABASE_URL.`            |
| `git diff --check`                                                        | Pass                                                              |

The installed npm fixture exercises the bundled launcher under an isolated npm
prefix and `KOED_HOME`, denies checkout imports, and records blocked network calls.
It accepts a pinned synthetic Base, rejects noncanonical manifests, canonical
wrong pins and corrupt archives, and excludes tampered stored payloads. This does
not prove native service startup, actual remote acquisition, a literal install on
another machine, or signed Desktop acceptance.

Read-only follow-up reviews identified candidate-code execution, mutable
catalog exports and decoy Desktop import checks. Final review also caught the
legacy candidate trust-root module import during promotion; static parsing now
replaces that import. A promotion-level regression embeds a top-level throw in
the candidate module and proves it is not executed. Regression tests cover those
reported cases. Static inspection does not replace behavioral acceptance.

## Unresolved gates

- Actual fresh native Base/Privacy and catalog-bearing candidates for Linux x64
  and macOS arm64; positive Personal/Team startup, online/offline acquisition,
  restart/shutdown and actual pre-promotion verification without publication.
- Signed/notarized packaged Desktop, clean-Mac first launch, relocation,
  helper/fuse, uninstall and the remaining Desktop/CLI lifecycle matrix.
- Database-required suites against an explicitly configured disposable database.
- Read-only confirmation of deployed signer rehearsal authorization and existing
  installations. Repository code is not evidence of live operational state.
- KMS release-signing/rehearsal infrastructure remains until replacement acceptance
  is proven. Retirement needs separate operational approval; no key destruction.
- Developer confirmed the minor changeset and authorized stack pushes. Core
  changes landed as incremental commits on #421; #428 and #432 merge upward
  without rewriting history. The changeset bumps the fixed product/Server group;
  Desktop is an ignored internal package in Changesets configuration.
- Fresh CI and re-review remain separate from the native/signed acceptance gates.
  Prior platform results and green checks do not prove the replacement pin path.

See [implementation plan](superpowers/plans/2026-10-23-release-stack-remediation.md)
and [implementation backlog](../TODO.md). Historical signed-path acceptance is not
proof of the replacement pin path.
