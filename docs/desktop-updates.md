# Desktop updates

Koed Desktop currently offers a notify-only update notice for eligible packaged macOS arm64 releases. When a newer stable release is found, the main bar shows **Update available** and Preferences → About → Updates shows installed/latest versions and plain-text release notes. Use **View release** to open the official Koed GitHub releases page.

Koed does not download an update, run an installer, restart, or install on quit. Update manually only after reviewing the release and confirming you can safely stop the local services.

## Safe manual update

1. Pause activity in every connected AI Client and stop active Koed CLI work.
2. For each Koed home on this machine, use that installation's existing Desktop CLI launcher to run `koed stop --json`.
3. Require the result to report `ok: true`, then recheck status and require `lifecycle.state: stopped` before proceeding.
4. If ownership of a home or its services is unclear, stop. Do not guess, terminate processes, or replace files.
5. Download the appropriate macOS arm64 release artifact from the official release page and follow that release's published instructions. Preserve each existing Koed home, configuration, and models.
6. Start Koed with the newly installed Desktop and verify its status before resuming AI Client activity.

The notice uses release metadata only; it does not download or verify installers and makes no claim that metadata proves native signing or notarization.
