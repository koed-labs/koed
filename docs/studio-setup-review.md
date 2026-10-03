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

Settings now has stable **AI Clients & models**, **Setup & health**, and
**Devices** sections. Desktop uses the existing local AI Client settings and
pairing APIs. Browser Studio reads authorized computer and model readiness over
the hosted launch-options route, and saves account flow defaults through the
existing authenticated local-agent-settings routes. Desktop remains the place
to install, sign in to, and repair clients on an execution computer.

## Identity and scope limits

The read model retains `hostedInstanceId` and `sourceDeviceLabel`, but never
exposes `sourceDeviceCredentialId`. Lists use the hosted instance ID so two
computers with the same provider-local instance ID remain separate. Existing
settings assignments still store the provider and provider-local ID. Browser
choices with a provider and Client ID duplicated across computers are disabled
because the persisted assignment cannot identify a computer. Identical
provider-local IDs under different providers remain separate choices.

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
