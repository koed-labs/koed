# Manifest-pin remediation: local verification

## Scope and status

Local remediation for #421 → #428 → #432 implements ADR-0057 and the approved
external standalone control-plane boundary. This is **not** release-candidate
acceptance or authorization to publish, promote, merge, retire infrastructure,
or claim the stack is ready for re-review.

Base commit before the uncommitted replacement work: `b2dac3cf3` (Task 1 activation
wording and prerelease ordering corrections are committed locally). Remaining
catalog, admission, packaging and workflow changes are local working-tree changes.
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

## Verification

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
| Fresh Server build followed by `node --test scripts/*.test.mjs`           | 379 passed, 1 skipped: live database fixture needs `DATABASE_URL` |
| `pnpm test:required-suites`                                               | Blocked: `Required database suite needs DATABASE_URL.`            |
| `git diff --check`                                                        | Pass                                                              |

The installed npm fixture exercises the bundled launcher under an isolated npm
prefix and `KOED_HOME`, denies checkout imports, and records blocked network calls.
It accepts a pinned synthetic Base, rejects noncanonical manifests, canonical
wrong pins and corrupt archives, and excludes tampered stored payloads. This does
not prove native service startup, actual remote acquisition, a literal install on
another machine, or signed Desktop acceptance.

Two read-only follow-up reviews identified candidate-code execution, mutable
catalog exports and decoy Desktop import checks. Regression tests cover those
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
- Minor changeset recommendation awaits developer confirmation. Stack repair,
  pushes, fresh CI, review-thread refresh and re-review packet remain pending.

See [implementation plan](superpowers/plans/2026-10-23-release-stack-remediation.md)
and [implementation backlog](../TODO.md). Historical signed-path acceptance is not
proof of the replacement pin path.
