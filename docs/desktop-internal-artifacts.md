# Unsigned Desktop artifacts for internal testing

Koed CI can produce unsigned macOS Desktop DMG/ZIP artifacts for internal install testing. These artifacts validate the current bundled Desktop shape and packaged native runtime behavior. They are unsigned and not notarized.

## Build in CI

Every pull request runs the macOS arm64 native-runtime and packaged Desktop native-smoke jobs. To build the same artifacts from another ref, run the `CI` workflow manually with `build_native_runtime_macos_arm64=true`.

The workflow:

1. builds and validates `koed-native-runtime-macos-arm64`;
2. extracts it for Desktop packaging;
3. sets `KOED_NATIVE_RUNTIME_SOURCE_DIR`;
4. builds unsigned `dmg` and `zip` Desktop artifacts;
5. runs packaged Desktop native smoke against the built app;
6. uploads `koed-desktop-macos-arm64-unsigned`.

The uploaded Desktop artifact contains `Koed-<version>-arm64.dmg` and `Koed-<version>-arm64.zip` from `apps/desktop/release/`.

## GitHub Release assets

When the `Release` workflow creates a new GitHub Release, it first creates it as a draft. It then runs a macOS job that:

1. builds and validates the macOS arm64 native runtime;
2. packages unsigned Desktop DMG/ZIP artifacts;
3. runs packaged Desktop native smoke;
4. uploads the unsigned DMG, ZIP, and `koed-desktop-macos-arm64-unsigned.sha256` checksum file to the GitHub Release.

The workflow verifies the Desktop, standalone server, checksum, and release metadata assets before publishing the draft. A failed build therefore leaves a draft instead of a visible partial release. If only the Desktop asset job needs to be rebuilt, run `Recover Desktop release assets` with the existing draft release name. Draft releases do not necessarily have a Git tag, so the workflow resolves the draft's `targetCommitish` to an immutable commit SHA before checkout. It then confirms that source contains both the pinned hermetic OpenSSL builder and the safe Desktop symlink/sealing behavior, repeats native-runtime validation and packaged smoke, replaces the Desktop assets, and publishes the release only when every required asset is present. The recovery workflow deliberately rejects published releases and source such as `v0.4.3` that predates the safe packaging boundary; repair those through a patch release instead of mixing current build tooling into historical source.

Packaged Desktop smoke writes detached supervisor output to `KOED_HOME/logs/supervisor.log`. The live log is capped at 8 MiB. If the supervisor exits before readiness, the smoke fails immediately, prints the supervisor, Postgres, runtime-state, and final-status diagnostics, and creates a uniquely named, smoke-owned child under the configured diagnostics directory for the short-lived workflow artifact. The caller-provided parent is never removed or replaced, copied service logs contain only their final 64 KiB, and secret-bearing configuration files are excluded.

These GitHub Release assets are still unsigned and not notarized until the signing/notarization follow-up is complete.

## Install/open manually

Download `koed-desktop-macos-arm64-unsigned` from the completed workflow run.

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

For CLI verification against an installed app, set paths and run packaged `koed-server` commands through Electron:

```bash
APP="/Applications/Koed.app"
EXE="$APP/Contents/MacOS/Koed"
RES="$APP/Contents/Resources"
RUNNER="$RES/app.asar.unpacked/dist-electron/koed-server/node-entrypoint-runner.js"
CLI="$RES/app.asar/node_modules/@koed/koed-server/dist/cli.js"
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

Expected result: packaged runtime source resolves under `Contents/Resources/koed-runtime`, runtime install/status succeed, doctor does not fall back to source-checkout paths, and packaged runtime contents do not require `embedding-service/.venv/bin/python`.

## Cleanup

Stop Koed from the app UI or CLI before deleting test data:

```bash
APP="/Applications/Koed.app"
EXE="$APP/Contents/MacOS/Koed"
RES="$APP/Contents/Resources"
RUNNER="$RES/app.asar.unpacked/dist-electron/koed-server/node-entrypoint-runner.js"
CLI="$RES/app.asar/node_modules/@koed/koed-server/dist/cli.js"

ELECTRON_RUN_AS_NODE=1 \
KOED_PACKAGED_DESKTOP=1 \
KOED_PACKAGED_RESOURCES_PATH="$RES" \
KOED_RUNTIME_MODE=local-personal \
KOED_DEPENDENCY_MODE=bundled-local \
WORK_QUEUE_BACKEND=local \
"$EXE" "$RUNNER" node-script "$CLI" stop --json
```

Then remove temporary app copies and test `KOED_HOME` if used.
