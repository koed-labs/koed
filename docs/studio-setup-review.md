# Studio setup and AI Client settings review

## Scope

Studio Desktop reuses the existing guided setup checklist for first launch and
for later setup or repair. The legacy Desktop keeps its existing confirmation
dialog; Studio setup uses a main-process native confirmation before Koed
package/runtime changes. Studio's generic invoke bridge uses a shared narrow
command allowlist, and its setup channel fails closed if the native consent hook
is unavailable. Both flows keep the optional Codex, Claude Code, and Pi setup
flow. Completion is saved through the existing onboarding state commands.
Setup inspection and progress use the existing desktop setup bridge.

Settings has **AI providers**, **Setup & health**, and **Devices** sections.
Desktop reads the saved local AI Client catalog and uses the existing pairing
APIs. Browser Studio reads authorized computers and provider readiness over
the hosted launch-options route. Settings lists providers rather than every
model; model selection remains in Agent and chat controls. Full Desktop setup
inspection starts with **Check status**, rather than automatically on page open.
Desktop exposes Add AI provider, Configure, Check status, and Enable/Disable.
Add and Configure reuse the existing client setup and repair commands. Account
sign-in and subscriptions stay in the original AI Client. Opening Settings reads
the saved catalog; discovery runs only when a check or integration operation is
requested. Disabling a provider preserves its installation and history, allows
running work to finish, and blocks future managed starts and sends. Desktop
remains the place to install, sign in to, and repair clients on an execution
computer.

## Claude Code configuration

Open Settings → AI providers → Anthropic → Configure. The setup controls open
beside that provider. Leave the optional executable field blank for automatic
detection, or enter an absolute Claude Code executable path. The Claude Desktop
GUI executable is not a Claude Code executable. Connect or repair Claude Code,
then read its status check
and next step in the same place. Checks show progress and completion explicitly.
Koed uses the existing installation and sign-in; it does not ask for an Anthropic
API key. If sign-in is required, authenticate Claude Code and check again.
Signing into Claude Desktop alone is not proof that its Code executable is
signed in.

On macOS, discovery also supports Claude Desktop's bundled Code executable when
no regular Claude Code installation is available on PATH. Repair updates Koed's
registered executable after Claude Desktop changes the installed version.

## Identity and scope limits

The read model retains `hostedInstanceId` and `sourceDeviceLabel`, but never
exposes `sourceDeviceCredentialId`. Lists use the hosted instance ID so two
computers with the same provider-local instance ID remain separate. Existing
settings assignments still store the provider and provider-local ID. Provider
availability changes target the hosted instance ID when available, so another
computer’s client is not changed accidentally. Browser provider status is
read-only; configuration stays on the selected execution computer.

Hosted launch options publish verified client/model readiness, not the remote
computer's Koed package, runtime, model download, services, integration, doctor,
or setup-verification stages. Browser Studio reports that limitation and does
not infer or fabricate remote package health. Local stage inspection and repair
are available in Studio Desktop on that computer.

## Pairing

Studio Desktop Settings exposes the existing Devices modal. Pairing deep links
are consumed through the existing pairing preload protocol, and the root
application routes accepted links to Studio. Browser Studio explains how to
start pairing in Desktop; it does not receive a local pairing capability.

## Scoped checks

- ESLint passed for the setup/settings components and the owned Desktop IPC,
  preload, and local AI Client read-model files.
- `pnpm --filter @koed/desktop exec vitest run src/ipc/commands.test.ts src/renderer/views/preferences/LocalAiClientSettingsSection.test.tsx`
  passed (30 tests), including Studio command allowlist, trust-origin,
  main-frame, required native setup confirmation, retained full Desktop
  permission checks, and provider/instance identity behavior.
- Studio typecheck, the production hosted export and the maintained browser
  regression suite pass (28/28). The export regenerates the original Desktop
  controls and CSS from source; it does not duplicate their implementations.
- Desktop typecheck and the affected collaboration/window tests pass
  (150/150). Existing root-thread operations now explicitly pass the current
  contract’s null root-message scope; fixtures use its validated defaults.
- Packaged first-launch testing identified an eager credential lookup before
  the window opened. The window now starts its loopback gateway immediately
  and resolves protected authority per request; window tests 12/12 and an
  independent authority review pass. After the Mac was unlocked for Keychain
  access, the packaged Studio renderer passed first-launch setup, native setup
  inspection, reload, Settings navigation, narrow command rejection, hydration
  checks and absence of the legacy window. Full packaged smoke also passed native
  installation, model/privacy verification, core/Codex setup, health, stop and
  restart (about 74 seconds), using an isolated temporary Koed/Codex home.
