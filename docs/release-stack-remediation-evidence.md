# Manifest-pin remediation: local verification

## Pin-only cleanup status

The stack is component pin-only in source. Component KMS, hosted signer,
roots, sidecars, component-signing OIDC and obsolete configuration/docs have been
removed before merge; they are not retained pending acceptance. Protected independently reviewed build identity,
read-only candidate verification, publication approval, npm authentication/provenance,
immutability and SRI remain mandatory. Actual native Personal/Team and signed/notarized
clean-Mac acceptance remain gates. No live cloud or repository-variable changes
are authorized or required. Apple Developer ID signing/notarization, unrelated
hosted/encryption KMS and legacy app-runtime provenance remain unchanged.

### Pin-only cleanup verification

Node **24.13.1**, pnpm **11.1.2**, macOS arm64, isolated #432-derived worktree.
These counts describe that worktree; independently restaged #421/#428 checks and
final-head CI are reported separately in their PRs:

- Server: **71 files, 969 tests passed**; obsolete component-signing helper coverage removed.
- Desktop: **100 files, 967 tests passed**, plus **77 Node smoke/packaging tests**.
- Root scripts: **509 passed, one database-dependent skip**. Pin-only promotion succeeds without signer credentials/sidecars; changed manifest, archive, catalog, npm bytes or candidate evidence reject before publication. Every second download is authenticated against the protected build before parsing.
- Full workspace build, full ESLint/Prettier, root test-source typecheck, Server and Desktop typechecks passed.
- Independent full cleanup review and final download-boundary review found no actionable P1/P2 findings.

These are local checks, not final-head CI or native/signed release acceptance.
The existing approved minor changeset is preserved. Prior checkpoint counts
**970/967/503** below are historical and do not describe this cleanup.

## Prior review follow-up: scope and remaining acceptance

Published #432 `605bf1c3680c361afaea741071d7e24141eb2929` already contains the
ordinary cross-version activation, install composition, prior-component diagnostic
and provisioning documentation fixes, plus protected candidate verification.
The earlier statement that those fixes had not reached #432 was stale. Lower-stack
propagation and final-head CI must be reported separately in each PR; a pushed
upper PR is not proof that its independently mergeable parents contain the fixes.

The next follow-up separates Desktop ownership/version discovery from runnable
admission, preserves the capability-bound ordinary-generation fallback, bounds
journal reads, and rejects Desktop replacement downgrades. Release ordering keeps
complete hyphenated prerelease identifiers. The historical signing rehearsal
used an explicitly synthetic manifest catalog for local payload integrity with
separate remote signature/tamper checks. This is historical signed-path evidence,
not pin acceptance or a requirement to retain the rehearsal.

### Prior follow-up local verification — not cleanup verification

Node **24.13.1**, pnpm **11.1.2**, macOS arm64, isolated worktree with a fresh
frozen-lockfile offline dependency installation. These counts apply to the
#432-derived follow-up; independently restaged #421/#428 checks belong in their
own PR evidence:

- Server: **71 files, 970 tests passed**. Includes old Privacy selection ownership
  discovery/status before Desktop bundle replacement, ordinary Desktop fallback,
  oversized-journal rejection, journal owner/digest tampering, and downgrade
  rejection without pointer changes.
- Desktop: **100 files, 967 tests passed**, plus **77 Node smoke/packaging tests**.
- Root scripts: **503 passed, one database-dependent skip**. Includes full
  prerelease ordering through protected candidate verification and the offline
  signing rehearsal with synthetic manifest/archive tampering.
- Full workspace build, full ESLint/Prettier and root test-source typecheck passed.
  Electron uses the already installed local binary; it was not downloaded again.

These are local regression checks, not final-head CI or native release acceptance.
The historical signing rehearsal was exercised with mocked OIDC/KMS only; no cloud
resources were modified and no actual KMS rehearsal is claimed.

### Previously recorded verification

The following results were recorded by the prior implementation agent, not newly
executed native acceptance for this follow-up. Node **24.13.1**, pnpm **11.1.2**,
macOS arm64:

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
source/configuration cleanup is required before merge independently of acceptance;
no cloud resource changes are authorized or required by source cleanup.

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
- Existing installation compatibility remains unestablished. Repository code is
  not evidence of live operational state. No signer inventory, retention or cloud
  retirement requirement is imposed by this source cleanup.
- Developer confirmed the minor changeset and authorized stack pushes. Core
  changes landed as incremental commits on #421; #428 and #432 merge upward
  without rewriting history. The changeset bumps the fixed product/Server group;
  Desktop is an ignored internal package in Changesets configuration.
- Fresh CI and re-review remain separate from the native/signed acceptance gates.
  Prior platform results and green checks do not prove the replacement pin path.

See [implementation plan](superpowers/plans/2026-10-23-release-stack-remediation.md)
and [implementation backlog](../TODO.md). Historical signed-path acceptance is not
proof of the replacement pin path.
