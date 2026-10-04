# Personal Studio review

The User prioritizes Personal Studio for the weekend review. A disconnected
Team backend is expected and must not block Personal or Settings. Team feature
acceptance remains a separate review. Ongoing work is still a discussed future
feature, not part of this build.

## Review order

1. Open Studio, close its window, reopen it from the menu bar, then Quit and restart.
2. Click the Settings gear. Check AI providers, Setup & health, and Notifications.
3. Check Project discovery and provider filters against the real local catalogs.
4. Create a test Project with the native picker. Open its Conversations and load more.
5. Start an Agent chat. Check streaming, follow-up messages, drafts after restart, and history.
6. Check Agent creation, role suggestions, cloning, retirement filters, and current activity.
7. Inspect Build progress for a real completed Personal Job.
8. Test a fresh Personal notification with Studio foreground, background, and window closed.

Report failures as they appear. Existing dummy Projects, Agents and Conversations
must not be deleted in bulk without confirming which records are disposable.

## Personal notification flow

Notifications do not require a Team connection. Start with a fresh Agent
approval request in a disposable Project. Old unread activity establishes a
silent baseline; reopening Studio does not replay it.

1. In Settings, enable system notifications. Allow Koed notifications in macOS if requested.
2. Start an Agent chat with the existing Ask before run permission mode.
3. Request a small terminal operation that requires approval under that AI Client's policy.
4. Move away from the chat before the request arrives, then background Studio.
5. Allow approximately 30 seconds for the notification poll after the request appears.
6. Check that the notice contains the event and names, without command or message text.
7. Click the notice. It should open the correct chat and leave the approval undecided.
8. Repeat with the Studio window closed while Koed remains in the menu bar.

If the AI Client automatically permits the chosen command, this does not test
approval delivery. Choose a genuinely permission-gated operation together with
the User rather than changing their permission policy silently. A completed
Job should stay quiet. Keep actual macOS display/click evidence separate from
browser fixtures and unit tests.

## Settings correction

The Personal rail inherited Electron's window-drag region. Its Settings link
did not override that region, so native clicks could be ignored. Settings,
Personal and the narrow-screen navigation button now explicitly use `no-drag`.
Native click acceptance remains required after the rebuilt package opens.

The corrected native package built successfully and passed deep signature
verification. Main-process inspection confirmed a visible Studio window and
the gear's computed `no-drag` style. Programmatic activation of that same link
opened `/settings` and rendered Settings, Notifications, and AI Clients & models.
This verifies routing and rendering; the User still needs to confirm a real
mouse click. The app was left open on Settings for review.

## Desktop AI Client bridge correction

The next User review found missing AI Clients. A shortened diagnostic rebuild
compiled the Electron entrypoints but omitted the subsequent preload bundling
step. The sandbox rejected the preload's relative imports, leaving
`window.koedDesktop` unavailable. Settings consequently selected its browser
path instead of the existing local AI Client settings path.

Rebuilding both preload bundles restores the native bridge. Electron packaging
now runs the existing preload import verifier before packing, including direct
electron-builder invocations. A negative fixture confirms that unbundled
relative imports are rejected; the rebuilt bridges pass that gate.

The corrected native package passed deep signature verification. Renderer
inspection confirmed the Desktop bridge, local AI Client API, and Settings
route. Its existing Agent selectors displayed Codex and Claude Code, with real
Codex model choices including GPT-6.1 Sol. These checks do not certify every
AI Client's sign-in or execution health.

## Settings scrolling and provider summary correction

Settings shows registered AI providers (OpenAI, Anthropic, and Pi when configured),
with their last reported status. It does not list individual models. Models are
selected in Agent and chat controls. Opening Settings reads the saved provider
catalog without triggering capability discovery. Full local setup and service
verification runs when you choose **Check status**. This avoids automatic model
file verification while opening the page.

The main Settings scroll area is explicitly excluded from the Desktop window
drag region. Verify native scrolling with the mouse or trackpad in the rebuilt
app, including scrolling to and past AI providers.

Validation: focused Settings lint and the production Studio build passed. The
rebuilt Desktop app passed preload and signature checks. Native renderer
inspection confirmed the Desktop bridge, OpenAI/Codex and Anthropic/Claude Code
provider rows, zero model selectors, and the manual setup-check state. Changing
the Settings scroll position from 842 to 1018 succeeded and the renderer stayed
responsive. Actual mouse/trackpad scrolling still needs User confirmation. The
app was left running on Settings with the temporary debugger closed.

## Settings navigation follow-up

When Settings or Plugins is open, the Settings rail icon is selected and the
Personal icon is not selected. Plugins has one entry in the Settings sidebar;
the duplicate General-page section was removed. General has explicit bottom
padding and its content does not shrink to the scroll container's height.

Provider management must reuse the existing AI Client setup and repair commands.
The User requested adding providers, configuring existing ones, and disabling
configured providers. The current status comes from saved local capability
reports; Ready does not mean the User just configured the provider in Settings.
The User confirmed that disabling blocks future execution only. Running work
can finish, and installation, sign-in, and history remain intact. Provider
management uses the existing Desktop integration commands and a narrow
enabled-state bridge. Memory capture policy is unchanged. Add connects an
installed client; Configure repairs its Koed integration. Sign-in stays in the
original client. Explicit checks update the displayed saved status even when
the provider reports that sign-in is needed.

Provider UI regression checks passed (5 cases): no automatic probes on page
entry, explicit checks, sign-in-needed checks updating a previously Ready row,
repair consent and failures, adding Pi, and disabling by hosted instance ID.
DB/API builds, owner-scoped API tests, and preload tests passed. The production
Studio build and Desktop compile/typecheck passed. Existing Desktop test
fixtures were updated for the new enabled-state bridge method.

Execution admission was also corrected for duplicate provider-local IDs across
computers. The worker matches the assigned device and deployment, resolves its
active credential, and checks the matching hosted instance and snapshot. A
missing or ambiguous match is rejected. The worker build and 86 focused
settings/service tests passed.

The final provider-management Desktop package passed preload and signature
checks and includes the PostgreSQL and llama.cpp native assets. Its first
launch is awaiting macOS Keychain approval. A bounded inspector check timed
out; a process sample identified Security.framework Keychain access on the
main thread. Native UI verification is pending that approval. Automated tests
did not change the User's provider configuration.

After delayed Keychain approval, Chromium restarted its network service and
the initial Studio navigation failed. The previous failure handler disposed
the gateway and called close on the failed window. On macOS, the regular close
handler hid that window instead of destroying it, leaving an orphan that also
vetoed Quit. The User reported the failure. Destroying only the known failed
window allowed normal Quit, and restarting the same signed build restored
Studio without changing user data.

Native inspection of the restored build confirmed provider action controls,
the enabled-state bridge, selected Settings and unselected Personal icons, no
General-page Plugins link, and an 80-pixel bottom gap. Startup recovery and
forced cleanup of failed windows are being corrected and regression tested.

## Delayed Keychain startup recovery correction

Studio navigation now retries transient failures with bounded attempts. Persistent
failure shows a local retry page while keeping the gateway available. If even
that page fails, cleanup destroys the failed window rather than allowing the
macOS hide-on-close handler to leave an orphan. Successful manual retry clears
the recovery state. Dock, menu, and second-instance opening handle rejected
startup promises and allow another opening attempt.

All 23 focused Studio-window tests and Desktop TypeScript checks passed.
Electron compilation, bundled preload verification, packaging, and deep strict
signature verification passed for `release/keychain-recovery-review/mac-arm64`.
The old responsive review build quit normally before launching this build.

Packaged validation is awaiting a fresh macOS Keychain approval. A process
sample confirms the new process is blocked in Security.framework
`SecItemCopyMatching`. The debugger fault-injection attempt did not complete
while that native call was blocked; it is not counted as a passing native
recovery test. Unit tests cover transient and persistent load failures, hung
loads, fallback failure cleanup, and reopening after successful retry. A real
delayed-approval restart and normal Quit still need confirmation after approval.

## Claude provider configuration follow-up

The User reported that Configure appeared to do nothing and Check status gave
no clear confirmation. Configure's panel was below the complete provider list.
A live check also reported that Claude Code could not start, although the
Claude Desktop bundled Code executable was installed and signed in. Claude
Desktop had updated its bundled executable; Koed's saved registration still
pointed to the previous version. Configuration must rediscover the current
installed executable and register it through the existing repair flow.

The basic Desktop workflow is Settings → AI providers → Anthropic → Configure,
connect or repair the installed Claude Code integration, then Check status.
If the check requests sign-in, sign in to Claude Code (not only Claude Desktop)
and check again. Provider setup must show its progress, diagnosis, and next
step beside the provider being configured. Installation, sign-in, and Disable
remain separate actions; enabling does not authenticate a client.

Focused provider UI tests (7), executable-discovery tests (13), typechecking,
and the production Studio build passed. Native inspection confirmed the new
check locates installed Claude Code. Repair then exposed a second compatibility
issue: the existing same-home Koed MCP entry pointed to the earlier source
runtime, while the new Desktop expected its packaged runtime. Repair correctly
refused to overwrite a connection it did not yet recognize. The follow-up
allows migration only when that prior entry is verified as Koed's own MCP CLI
and targets the same Koed home. Unrelated MCP connections remain protected.

The real repaired Claude check now passes: `healthy`, `authenticated`, with
capture and MCP recall configured for the installed Claude Code 2.1.286 binary.
The User then requested an explicit executable-path input. Configure will allow
an optional absolute Claude Code executable path, checked through the existing
repair flow and saved in the existing registry. Empty means automatic discovery.
The main Claude Desktop GUI executable is rejected with guidance to select the
Code executable. No new API key or separate provider-account store is introduced.

Manual executable selection reuses `repair_claude` with an optional absolute
`executablePath`, forwarded as an argument to the existing Claude CLI setup
flow. That flow performs version/authentication checks and saves the validated
path in the existing registry. Status prefers a valid saved registration;
explicit environment overrides remain fail-closed, and stale saved files fall
back to installation discovery. Claude Desktop's GUI launcher is rejected
before execution. Tests passed: provider UI (8), setup/CLI/status (153), Desktop
manager (96), and server/Desktop typechecking.

Final native verification passed in the `claude-provider-settings` Desktop
package. Configure displayed the optional path field beside Anthropic. Entering
the installed CLI path and clicking Repair and check status showed progress,
completed repair and the automatic check, and left Anthropic Ready with all
controls enabled. The app was left open on AI providers. The final package
passed bundled-preload and deep strict signature verification and retained its
PostgreSQL and llama.cpp assets. Changes are local; no GitHub push was requested.

## Personal Project and Conversation removal

The User requested controls to clear test Projects and threads from Personal
Studio. Their confirmed scope is **Remove from Studio; keep files and memories**.
Removal is a persistent account preference for browsing lists. A removed Project
also hides its contained Conversations from those lists. Removing a Conversation
must cover its managed and discovered source representations so a refresh does
not bring it back under a different row.

Removal does not cancel active Agent work, erase chat history, change Team
sharing, or remove captured memories or files. The UI must explain this before
confirmation and provide an Undo action after successful removal. Failed saves
must leave the item visible and show an error. Validation uses disposable records;
the User chooses which existing Projects and Conversations to remove.

Removal validation passed: owner-authenticated API and route identity tests,
Desktop gateway CSRF tests, disposable PostgreSQL migration/persistence/owner
isolation/restart/Undo checks, UI filter and confirmation checks, existing
Personal Agent client regression tests, Studio production build and lint.
The packaged test caught a missing write token; the final client now reuses
Studio's shared session-token flow rather than bypassing request protection.

Final packaged renderer checks passed in a separate hidden test window against
the real local gateway and database: Cancel retains a Project, rejected saves
leave it visible with an error, successful Project and Conversation removals
persist, Undo restores them, Project children hide with their parent, and the
same exclusion applies after New chat navigation and Home remount. Only
uniquely controlled test IDs were written, then restored. Existing User data
was untouched. The signed `personal-removals-final` package was left running
with one visible Studio window; the test window and inspector were closed.

Desktop workflow: hover a Project or Conversation row, select its trash icon,
then confirm **Remove from Studio**. Touch layouts keep the icon visible.
Select **Undo** in the sidebar to restore the last removal. The User can now
choose which existing test Projects and threads to hide.
