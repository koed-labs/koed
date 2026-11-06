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

Memory Model selects one connected AI Client, model, and reasoning level for
Memory Answer synthesis, LCM summaries, captured-session titles, and Curated
Memory reviews. Select **Save Memory Model** to apply the choice to all four
tasks. The selector lists clients with a current, authenticated Local Synthesis
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
expansion step. The back button and Escape return to Services.

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

## About

About shows the installed Koed Desktop version. Use **Check for updates** to check for a newer release when updates are available for this build. If Koed finds one, use **Download** to open its download.
