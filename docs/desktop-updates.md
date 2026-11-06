# Desktop updates

Koed Desktop currently offers a notify-only update notice for eligible packaged macOS arm64 releases. When a newer stable release is found, a small **Update available** card appears at the bottom of the conversation sidebar on every screen, showing the installed and available versions. **Download** opens the official installer for the running platform in your browser (for example `https://github.com/koed-labs/koed/releases/download/v0.10.3/Koed-0.10.3-arm64.dmg`), and Preferences → About → Updates offers the same download plus **Check again**. Dismissing the card hides it for that version only; a dot on the Settings rail button and the About tab keeps the update discoverable. Release notes and update instructions are not shown in the app; release notes are on the release page.

Koed itself does not download an update, run an installer, restart, or install on quit. The installer is only offered when the release publishes the expected installer and checksum assets for the running platform, at their official download URLs.

## Updating Koed Desktop

1. Quit Koed.
2. Open the downloaded `.dmg` and drag Koed into Applications, replacing the existing app.
3. Open Koed again.

Koed homes, configuration and models live outside the app bundle and are kept.

## Advanced: CLI-managed Koed homes

If you also run Koed homes from the CLI, stop them safely before replacing the app:

1. Pause activity in every connected AI Client and stop active Koed CLI work.
2. For each Koed home on this machine, use that installation's existing Desktop CLI launcher to run `koed stop --json`.
3. Require the result to report `ok: true`, then recheck status and require `lifecycle.state: stopped` before proceeding.
4. If ownership of a home or its services is unclear, stop. Do not guess, terminate processes, or replace files.
5. Download the appropriate macOS arm64 release artifact from the official release page and follow that release's published instructions. Preserve each existing Koed home, configuration, and models.
6. Start Koed with the newly installed Desktop and verify its status before resuming AI Client activity.

The notice uses release metadata only; Koed does not verify the downloaded installer and makes no claim that metadata proves native signing or notarization.
