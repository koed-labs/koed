# Unsigned Desktop artifacts for internal testing

Koed CI can produce unsigned macOS Desktop DMG/ZIP artifacts for internal install testing. These artifacts validate the current bundled Desktop shape and packaged native runtime behavior. They are unsigned and not notarized.

## Build in CI

Ordinary pull requests do not upload unsigned distribution artifacts. Relevant
pull requests build and smoke only the unpacked `.app`; the Changesets release
pull request and manual/scheduled full validation build DMG/ZIP outputs for
validation but do not publish those candidate files.

The post-merge `Release` workflow publishes signed/notarized Desktop assets,
not these internal candidates. See [Desktop notarization](desktop-notarization.md)
for protected-environment setup, publication gates, and clean-Mac acceptance.
See `docs/ci-validation.md` for validation dispatch options and PR routing.
To create internal candidates locally, run `pnpm desktop:package:internal:mac`;
artifacts appear under `apps/desktop/release`.

## GitHub Release assets

The normal release path cold-builds and validates the macOS arm64 native runtime,
uses electron-builder's built-in signing/notarization, verifies the app and mounted
DMG, runs packaged native smoke and composition policy, and uploads DMG/ZIP plus
`koed-desktop-macos-arm64.sha256` to a draft. Publication requires successful signing
and all existing server/metadata/promotion gates. Administrator setup and real
signed-release acceptance are still required before claiming operational success.

Manual Desktop asset recovery is disabled. Fix failures and rerun the normal
pipeline; rebuild old versions through patch releases. Uploads never overwrite
different existing bytes, so a conflicting rerun also requires a patch release.

Packaged Desktop smoke launches the real packaged manager with a private inherited
IPC harness and temporary user-data directory. The manager owns supervisor
start/status/stop/restart and creates its private supervisor authority channel;
no environment flag grants that authority. While the owned supervisor is running,
status/startup status, doctor, core setup, and Codex setup/repair use nonce- and
request-ID-correlated private IPC. The supervisor passes its reverified, sealed
Desktop capability directly to runtime selection; it never serializes capability
authority into CLI arguments or environment variables. Guided setup uses the same
transport, and pending requests reject on timeout, child exit, or disconnect.
Startup acquires its supervisor lock
before pinning the verified runtime generation. Only start pinning may accept that
same live PID and exact process identity; existing generation pins, foreign or
uncertain supervisor ownership, activation, and cleanup remain blocked. Lifecycle
and component-store locks still protect generation selection and retention.
Personal/Base smoke requires embedding,
not Privacy assets. A separate Team launch verifies startup fails closed without
verified Privacy assets; empty production signer trust roots block positive Team
provisioning. Supervisor output is written to `KOED_HOME/logs/supervisor.log`. The live log is capped at 8 MiB. If the supervisor exits before readiness, the smoke fails immediately, prints the supervisor, Postgres, runtime-state, and final-status diagnostics, and creates a uniquely named, smoke-owned child under the configured diagnostics directory for the short-lived workflow artifact. The caller-provided parent is never removed or replaced, copied service logs contain only their final 64 KiB, and secret-bearing configuration files are excluded. Team smoke failures preserve diagnostics from their separate Team home before cleanup, with Team mode enabled for the final status probe. The artifact also includes the final 64 KiB of Desktop output. Private management handshake failures include the final 4,000 characters of supervisor stderr in the startup error; this does not change readiness or Privacy enforcement.

Only local/internal candidates and historical unsigned releases use the unsigned
installation instructions below. New production assets must pass signed-release
gates; do not bypass Gatekeeper to validate a signed release.

## Install/open manually

For a local/internal candidate, use `Koed-<version>-arm64.dmg` or
`Koed-<version>-arm64.zip` from `apps/desktop/release`. Historical unsigned releases
may include `koed-desktop-macos-arm64-unsigned.sha256`. For new signed release
assets, follow [normal download-and-launch acceptance](desktop-notarization.md#first-signed-release-clean-mac-acceptance)
instead of the warning bypasses below.

DMG path:

1. Open the `.dmg`.
2. Drag `Koed.app` to `/Applications` or another test location.
3. Open with Control-click/Right-click → Open.
4. Confirm the expected unsigned-app warning.

ZIP path:

```bash
unzip Koed-*-arm64.zip -d /tmp/koed-desktop-test
open /tmp/koed-desktop-test/Koed.app
```

macOS may block unsigned builds with Gatekeeper warnings. For internal test machines only, remove quarantine if needed:

```bash
xattr -dr com.apple.quarantine /tmp/koed-desktop-test/Koed.app
open /tmp/koed-desktop-test/Koed.app
```

Do not present these unsigned artifacts as signed or notarized release builds.

## Runtime setup/status/doctor checks

Use the app UI first: launch Koed Desktop, wait for local startup, then check runtime setup/status/doctor controls.

For standalone diagnostic CLI verification against an installed app, set paths and
run packaged `koed-server` commands through Electron. These commands do not gain
Desktop authority and cannot establish healthy Desktop-owned generation status;
use app controls for that acceptance check:

```bash
APP="/Applications/Koed.app"
EXE="$APP/Contents/MacOS/Koed"
RES="$APP/Contents/Resources"
RUNNER="$RES/app.asar.unpacked/dist-electron/koed-server/node-entrypoint-runner.js"
CLI="$RES/app.asar/node_modules/@koed-labs/server/dist/cli.js"
export KOED_HOME="${KOED_HOME:-$HOME/Library/Application Support/Koed}"

ELECTRON_RUN_AS_NODE=1 \
KOED_PACKAGED_DESKTOP=1 \
KOED_PACKAGED_RESOURCES_PATH="$RES" \
KOED_RUNTIME_MODE=local-personal \
KOED_DEPENDENCY_MODE=bundled-local \
WORK_QUEUE_BACKEND=local \
"$EXE" "$RUNNER" node-script "$CLI" runtime status --json

ELECTRON_RUN_AS_NODE=1 \
KOED_PACKAGED_DESKTOP=1 \
KOED_PACKAGED_RESOURCES_PATH="$RES" \
KOED_RUNTIME_MODE=local-personal \
KOED_DEPENDENCY_MODE=bundled-local \
WORK_QUEUE_BACKEND=local \
"$EXE" "$RUNNER" node-script "$CLI" doctor --json
```

Expected result: diagnostics never fall back to source-checkout paths, environment
flags do not authenticate a Desktop generation, and packaged runtime contents do
not require `embedding-service/.venv/bin/python`. Standalone doctor may report no
compatible authenticated runtime even while Desktop is healthy; only the private
manager/supervisor status channel carries Desktop's sealed capability.

## Cleanup

Stop Koed from the app UI before deleting test data. Packaged lifecycle authority
belongs to the Desktop manager, not public CLI start/stop or environment flags.

Then remove temporary app copies and test `KOED_HOME` if used.
