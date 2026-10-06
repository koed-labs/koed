# Public server distribution: branch status

This branch is **not code-complete or release-ready**. Do not merge or publish it as completed handoff implementation.

## Implemented

- Public `@koed-labs/server` identity, coordinated minor changeset, lean independently installable `koed` control plane and lazy command dispatch.
- Strict effective configuration, hermetic base/privacy assembly, authenticated component manifests and bounded archive/tree verification.
- Immutable component staging, generation records, lifecycle exclusion, ownership, process pins, stopped activation and rollback guards.
- Trusted standalone startup and AI Client integration paths, explicit component provisioning commands, offline inputs and npm installation smoke coverage.
- Release artifact identity, immutable uploads/retries, external signing and npm candidate verification/promotion adapters. Production authorization remains gated.
- Desktop bundle validation and sealed internal capabilities, optional component and launcher Preferences controls, IPC interfaces, conflict-safe launcher/PATH helpers and runtime helper probe.

## Implementation blockers — not external acceptance criteria

1. Desktop bundled Base is validated but is not admitted into authenticated generation storage or selected through private supervisor startup authority. Packaged Personal startup is not complete.
2. Desktop manager does not implement the privacy installation capability consumed by Preferences. Consent/progress/cancel/retry/offline controls report unavailable; they are not an operational provisioning flow.
3. Private Desktop supervisor channel, bundled-generation pinning and manager-owned activation remain unimplemented. Do not bypass these with environment variables, CLI owner flags, unsigned public manifests or weakened standalone ownership checks.
4. End-to-end packaged Desktop lifecycle, relocation, uninstall and terminal-helper validation still need implementation-level integration and platform verification.

These blockers correspond primarily to implementation plan Tasks 10–13 and prevent completing Task 16 acceptance accounting.

## External gates

- Install real production trust roots into control-plane builds; configure an authorized signer and matching trust-root identities.
- Confirm npm organization/package ownership and publication credentials; execute authorized release promotion separately.
- Validate Linux/native artifacts and packaged Electron runtime/helper/fuse behavior on supported targets.
- No publication, signing-service authorization or credential changes were performed locally.

## Verification

Final local checks used Node 24.13.1:

- Server: 55 test files, 747 tests passed; typecheck and build passed.
- Desktop: 86 test files, 803 tests passed; typecheck and build passed. Existing large-chunk warning remains.
- Script suites after final fixes: 307 passed, 1 skipped, no failures.
- Root lint passed after final fixes.
- Targeted formatting passed during implementation. Full formatting remains affected by locally ignored SDD working Markdown; final tracked-file formatting is checked separately.
- Root database-dependent test suite previously stopped at `Missing required environment variable: DATABASE_URL`; no database readiness claim.

One final security review identified Desktop integration and launcher/filesystem safety blockers. Launcher and filesystem findings were fixed; Desktop integration remains open. Unit tests do not establish packaged Desktop acceptance.

Architecture and operation documentation were updated. Remaining work must preserve fail-closed behavior and replace unavailable adapters with real integration, not simulated success.
