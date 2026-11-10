# Desktop settings

Open Settings with the gear button at the bottom of the Desktop sidebar. Choose General, AI models, Services, or About in the Settings sidebar. In a narrow window, these sections appear across the top.

## General

General lists Appearance, On this device, and Optional tools, in that order.
Appearance selects System, Light, or Dark. Device preferences include opening
Koed at login, menu-bar visibility, and graphics acceleration when supported.
Run setup again remains available when the installation supports it.

Optional tools contains Privacy Filter and Command line. Select either card to
open its setup page in the right-hand settings pane. The parent-labelled back
button returns to General. Escape also goes back one level; Escape on the
General overview closes settings.

Setup continues while you return to General, switch settings sections, or close
settings. Reopen the tool page to see current progress. To cancel Privacy Filter
installation, use its explicit cancellation action while it is available.
Cancellation is no longer available during activation.

Privacy Filter installation downloads the optional runtime and pinned model.
Read [Optional Privacy Filter installation](optional-privacy-installation.md)
for readiness, supported platforms, verification, cancellation, and recovery.
Downloaded files alone do not establish readiness. A staged or failed
installation reports its current state and the next supported action.

Command line installs the desktop launcher and configures the shell PATH.
After setup reports ready, open a new terminal and run `koed status`. If PATH
configuration fails after the launcher was installed, retry setup to complete
PATH configuration. Removing the command line removes its Koed-managed PATH
entry and launcher; unrelated commands and shell configuration are preserved.
An unavailable installer bridge or an operation that requires a packaged app
shows that restriction rather than claiming installation succeeded.

## AI models

During onboarding, you choose a Memory Model after connecting your AI Clients.
This client, model, and reasoning level apply to Memory Answer synthesis, LCM
summaries, captured-session titles, and Curated Memory reviews. To change your
choice later, open **Settings → AI models**, choose the new model, and select
**Save Memory Model**. The selector lists clients with a current, authenticated Local Synthesis
capability and a reported model and reasoning level.

When earlier assignments differ, Settings asks you to choose a shared model.
Opening Settings preserves the existing assignments. Each task keeps its own
execution timeout and retry limit when you save.

## Services

Services shows the number of healthy services and, when the deployment offers
embedding telemetry, pending embeddings and throughput. Counts reflect the
components reported by the installation; optional components need not be present.
Unavailable telemetry is not a zero count or an all-healthy result.

Select Service health to read each reported component's state and any attention
message. Select Embedding status to inspect model readiness, pending work,
estimated drain time, throughput, Memory and LCM queues, Live Projection, and
historical-import admission. These are nested pages, with no additional
expansion step. Use the back button or Escape to return to the Services overview
for service actions. Both detail pages offer Refresh status.

Embedding is up to date only when idle activity is backed by backlog telemetry.
Missing telemetry reports unknown or unavailable progress. An unavailable
Embedding Service or incompatible model needs attention. Historical import can
pause while live capture has priority; its displayed reason describes admission,
not deletion or completion of pending history.

Refresh status requests a current snapshot. While Services is open, extra startup
refreshes run for up to one minute. Use Refresh status to check a longer startup
and begin another refresh window. Start or Restart Koed, Run diagnostics, Open
logs, and Copy diagnostics use the existing desktop operations. Failures remain visible;
a failed stop prevents restart from proceeding to start. Copied diagnostics
include only the existing allowlisted service states and timestamp.

### Hardware Acceleration

Hardware Acceleration appears below Service details. Its processing selector
shows the saved preference; the model row reports the backend verified by the
Embedding Service. Privacy Filter reports its own verified provider in a
separate row.
CPU, CUDA, and Metal are processing backends; they are separate from the AI
Client's Memory Model. A saved automatic preference does not establish that a
GPU is active. Stopped services and unavailable observations are shown explicitly.
During a processing change, the summary shows progress until the new backend and
any installed Privacy provider can be checked.
Readiness comes from authenticated service health, including while the supervisor
is still starting. Local checks use the ports allocated to the running services.
After a successful change, the summary shows the current backend without a
completion notice or default footer message.

Choose CPU or the available GPU option and select **Apply**. GPU processing saves
the shared automatic preference, allowing visible CPU fallback. Changes retain
the embedding model and stored vectors and do not start reindexing. Switching
to CPU retains optional CUDA assets for reuse. The General graphics acceleration
setting is separate and controls Desktop rendering.

On a supported Linux NVIDIA device without the add-on, select **GPU · CUDA**
to review download and free-disk requirements from the release catalog and
reusable local payloads. Select **Apply** to install and enable CUDA. Opening
Settings or changing the selector alone never downloads CUDA. A compatible
older installed runtime remains usable when an update is available.

When GPU processing falls back to CPU, the explanation appears in the existing
footer without adding a row or changing the card height. Startup and
operation failures remain visible; **Check again** refreshes an unavailable or
failed observation.

CUDA installation requires the pinned embedding model and validates GPU offload
and CPU/GPU embedding agreement before activation. Device discovery alone is not
inference verification. Only a successful installation saves automatic processing.
The existing card footer shows progress through download, verification, model
inference, and activation without adding a progress row. **Cancel** replaces
**Apply** while cancellation is available; it waits for installer cleanup. After a failure,
retry the explicit installation or apply CPU processing. Installed payloads remain
available for reuse.

Desktop confirms ownership and shutdown before saving a change for a running
installation, then restarts and checks the active backend. A failed stop prevents
the change. A stopped installation saves the choice and remains stopped. A newer
explicit stop prevents an operation from restarting services. Configuration that
changes after inspection requires another check before it can be applied.

Operator environment overrides, external Embedding Services, and runtimes owned
by another installation are read-only here. Operations are coordinated with setup
and native asset installation. Status belongs to the main process, so closing
the Settings section does not cancel a processing change.
Source installations identify their owner through the live supervisor lock, so
Settings in the same checkout can switch processing. Missing ownership is shown
as unverified rather than attributed to another installation. Older source
supervisors need one service restart to publish their ownership record.
Window reload reconnects to the same operation. A main-process interruption leaves
a local operation receipt; reopening rereads the actual runtime selection,
preference, model, and authenticated service state. It reports interruption without
inventing progress, claiming rollback, or restarting installation automatically.
Finished operation receipts do not reappear as notices after an application
restart. Current-session failures remain visible, with concise recovery copy in
the card and the detailed failure retained in the operation status.

The same preference affects an installed Privacy Filter. Its provider and
fallback are reported independently using its authenticated runtime status.
Embedding CUDA does not install or qualify Privacy CUDA, and embedding Metal
does not imply a Privacy provider. Unknown provider status is not GPU readiness.

## About

About shows the installed Koed Desktop version. Use **Check for updates** to check for a newer release when updates are available for this build. If Koed finds one, use **Download** to open its download.
