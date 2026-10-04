# Studio internal release

## Desktop shutdown correction

During unlocked review, the User reported a Studio process that would neither
show its window nor finish quitting. Restart restored the local UI server.
The gateway shutdown path could wait indefinitely for active event streams;
it now closes its HTTP connections when stopping. A regression test keeps an
event stream open and verifies that shutdown completes and releases the
subscription. This identifies a shutdown defect, not proof of the original
window failure's cause. Native reopen and Quit still require review of the
corrected package.

The corrected package passed deep signature verification. On launch, a native
process sample showed its main thread waiting inside macOS Keychain access
(`SecItemCopyMatching`). Approval of the rebuilt app's Keychain prompt is
needed before continuing that startup review; the app must not bypass it.

A second report arrived after Keychain access had completed. The process had
no remaining UI listener but still did not exit. Desktop now runs cleanup once,
prevents activation from reopening Studio during Quit, and exits if cleanup
rejects or exceeds 15 seconds. Existing cleanup runs normally before that
deadline. Focused shutdown, startup and lifecycle checks passed (39 tests),
as did Desktop compilation and linting for the changed files.

The rebuilt `release/shutdown-recovery/mac-arm64/Koed.app` passed deep signature
verification. Native main-process inspection confirmed one visible window,
finished loading, and a responsive event loop. Calling Electron's `app.quit()`
then exited the process successfully without Force Quit or the cleanup-deadline
warning. This verifies that launch and Quit attempt; broader notification and
feature acceptance remains separate.

This delivery targets web and macOS Desktop for internal review. Public
signing, notarization and distribution follow acceptance. Windows/Linux
installers and feedback on Team-visible recalled answers remain follow-ups.
Private Agent-chat answer feedback stays available, including authorized Team
Memory recall. See the individual review documents for feature evidence.

## Isolated web staging

Use the existing server deployment with its PostgreSQL, queue, embedding and
privacy dependencies. Give staging a separate Compose project, env file,
database, encryption keys, credentials, volumes and ports. Do not copy a
production database or credentials. Keep secrets outside the source/build
context and release artifacts.

1. Generate a staging env file using `KOED_ENV_PATH` and `pnpm env:setup`.
2. Configure unique ports, the intended HTTPS origin, supported deployment
   identity/authentication, and the staging model directory. For private Tailscale
   staging, set `KOED_DEPLOYMENT_PROFILE=team_self_hosted`; enrollment verifies
   the profile advertised by the server. Use real isolated review accounts,
   rather than a developer identity bypass, for live acceptance.
3. Build a reviewed server runtime image and the hosted Studio export with
   `NEXT_PUBLIC_KOED_STUDIO_HOSTED=1 pnpm --filter @koed/studio build`.
4. Set `STUDIO_STAGING_IMAGE`, `STUDIO_STAGING_EMBEDDING_IMAGE` and `STUDIO_STAGING_STATIC_DIR` in the private env
   file. The embedding image may reuse a verified unchanged runtime; its staging
   credentials and cache volumes must remain separate. Deploy with the existing server Compose file and the staging overlay:

   ```sh
   docker compose --project-name koed-studio-staging \
     --env-file /absolute/private/staging.env \
     -f examples/server-compose/docker-compose.yml \
     -f examples/studio-staging/compose.yml \
     --profile public-gateway-test up -d --no-build
   ```

5. Expose the public gateway only through a tailnet-only HTTPS Tailscale Serve
   port. Keep `/internal/*` blocked. Public registration stays disabled; provision
   review accounts through the existing Operator mechanisms.
6. Verify `/ready`, login, `/studio/`, authorization, and the selected execution
   computer before running the feature scripts. A page loading does not prove
   that its execution computer is enrolled or that an AI Client is signed in.

The temporary host approved by the User is this Mac. The same deployment can
move to a VPS after its availability and identity configuration are verified.
Stopping staging should preserve its volumes; deleting data is a separate action.

## macOS review package

Build through `pnpm desktop:package:internal:mac`. This uses the existing Koed
runtime staging and produces an internal DMG/ZIP. Include native assets using
`KOED_NATIVE_RUNTIME_SOURCE_DIR` when available. This review uses the existing pinned source-build pipeline for
PostgreSQL, pgvector and llama.cpp, with executable, loader, extension and
packaged-provider verification. Public redistributable certification remains
a separate release gate.

Verify package integrity, staged gateway startup, first launch with an isolated
`KOED_HOME`, setup/health, device pairing, and the required local/hosted flows.
Studio is the default window for launch, tray opening and Dock activation.
The internal package uses ad hoc signing; it is not a notarized public release.

## Release record

The User approved a combined minor-version product changeset for the delivered
epic. Record actual build revision/digest, artifact checksums, executed checks,
and any unresolved acceptance item before calling the release ready. Do not
claim deferred functionality as shipped or external-provider tests as passed
from fixtures alone.

## Shared Desktop controls in the web build

Studio builds a browser-only bundle from the existing Desktop setup, Client
configuration and Devices controls. Run the Studio package scripts for development,
build and typecheck; each regenerates the ignored `.desktop-ui` output. The bundle
keeps React in the Studio application and emits the original onboarding styles.
There are no copied component implementations or native server modules in that
browser bundle. The static export and packaged gateway need no build tools at runtime.

## Current Mac acceptance limits

The isolated Mac staging UI, account login and authorization checks pass. Its
new Privacy Service exceeded Docker’s 8 GB memory budget while the older review
stack was also running. With User approval, the older API, embedding and privacy
containers were paused; their databases, Redis and data remain intact. The new
Privacy Service is healthy with zero restarts after that change. The isolated review computer is now enrolled with the approved managed-execution,
capability-publishing, file-read and terminal scopes. Its supported Personal Device Group bootstrap also completed after the isolated
API authority signer was configured. Live Job/Skill validation is still underway.

The internal DMG/ZIP build and deep app/mounted-DMG signature/version checks
pass. After the User arranged local Mac access, the full packaged smoke passed
in about 74 seconds: Studio first launch, native setup inspection, reload,
Settings navigation, command restrictions, native runtime installation, model
verification, privacy runtime, core/Codex setup, health, stop and restart. These
checks used an isolated temporary Koed/Codex home; original provider settings
were preserved. A subsequent enrollment fix added the authenticated local owner
ID required by the existing CLI, with fail-closed credential tests. The rebuilt
installer passes integrity checks and its repeated full packaged smoke passed
after the User confirmed the new Keychain approval. The evidence records the
final DMG/ZIP checksums; it is not inherited from the earlier artifact. Public signing and
notarization remain outside this internal release.

Pi 0.84.2 is installed behind a local-only sandbox wrapper, and real read-only
discovery returned one Skill and no extensions with that sandbox preserved.
Koed had no registered Pi instance, so this was an explicit in-memory discovery
probe. Registration and actual hosted invocation have not been claimed.

## Notifications added during final review

The User approved the notification behavior recorded in [Studio notifications review](studio-notifications-review.md). Implementation and its final package validation are in progress. The earlier successful packaged smoke covers the pre-notification artifact; it must not be used as evidence of native notification display or delivery after closing the Studio window.

The initial isolated live Job check stopped before enrollment because staging advertised an incompatible deployment profile. After the supported profile correction, owner approval and scoped enrollment completed. A fresh disposable profile is now checking the existing Personal Device Group bootstrap; no live Job or native Skill invocation is certified yet. No network-policy bypass was used. Existing staging health, two-account authentication and protected-route checks passed again after the final hosted notification build.

### Private staging enrollment correction

The read-only diagnosis confirmed that staging advertised the `developer` deployment profile. Capability refresh correctly replaced the initially selected client profile with that advertised profile, and the existing network guard correctly rejected a private upstream. The private staging configuration now uses the supported `team_self_hosted` profile; only the separate staging API and its gateway were restarted. The network guard remains unchanged. A new provider-review profile must disable historical import and every transcript watcher, with separate CLAUDE_CONFIG_DIR, PI_CODING_AGENT_DIR, CODEX_HOME and KOED_HOME, before runtime startup. Preserve macOS HOME for supported GUI/Keychain behavior and explicitly scope the device proof store with KOED_DEVICE_PROOF_DIR when using an isolated identity. The previous disposable profile inherited Claude discovery; it was stopped and its exact temporary directory was removed. These environment corrections do not certify a completed live Job.

### Packaged smoke capture isolation

The maintained package smoke now explicitly disables historical import and Codex, Claude and Pi transcript watchers, and scopes all three provider discovery directories to its temporary profile. These overrides apply even when the invoking shell enables capture or points at existing provider data. Its seven helper tests pass, including the inherited-environment isolation regression. The final package smoke will use this corrected harness; earlier smoke evidence does not certify capture isolation.

### Source-aligned notification package checkpoint

The final notification-enabled 0.9.0 internal DMG/ZIP build and deep app signature/package checks passed. Artifact fingerprints are recorded privately in `.scratch/final-delivery/notification-mac-artifact-checksums.json`. The corrected capture-isolated packaged smoke stopped before a Studio renderer became available while macOS reported a locked console session. The pre-notification smoke remains historical evidence only; final native window and macOS notification acceptance need an unlocked session. No public signing/notarization or GitHub publication is claimed.

### Staging Personal Device Group authority

An enrolled execution computer also needs the existing Personal Device Group authority. In this isolated staging environment, the API was configured with `PDS_AUTHORITY_SECRET_REF=pds-authority` through a private Compose override. The bundled server supplies its existing headless secret-provider integration; on an empty authority store the supported API startup provisions and stores the signing material through that provider. Keys are not placed in raw environment variables or release artifacts. Only the isolated staging server was restarted.

The owner-authenticated supported bootstrap then created the disposable review account's active group. Future closed-session synchronization is enabled; historical backfill is disabled. Do not invent a group genesis, inject database membership, or bypass pairing checks. An existing deployed authority must retain its signing secret; do not use an empty-store provisioning procedure to replace it.

The existing launch-options authority requires both `sync` and `managed_execution` on an enrolled target device. The disposable staging review therefore also uses owner-approved `sync`, alongside capability publishing, file-read and terminal scopes. This is an existing authority requirement, not a new permission route. Historical backfill and provider transcript capture stay disabled.

### Final bounded execution result

A real owner-authenticated supervised Codex Conversation started through staging and settled as `stopped` after the supported Stop command. It was not a Personal Agent Job; completed Build Job history remains unverified. Hosted Skill discovery exposed a PostgreSQL parameter typing defect; the query was fixed and its operation creation now passes a real disposable PostgreSQL regression. The corrected backend image and macOS installer rebuilt successfully. The isolated staging API and gateway were refreshed, preserving the existing authority secret and data. Final installer signature/package integrity and DMG checks passed again. Completed hosted native discovery/Skill invocation still need a separate live review. The temporary execution profile is stopped and removed.

## Publication review checkpoint

The User authorized publishing this work to `epic/ui-revamp` before completing the recorded live/native checks. API and Studio typechecks and the synchronized 0.9.0 release check pass. Final formatting is applied to touched supported file types. New resource-discovery lint findings were corrected before publication; 35 lint findings across five previously tracked files were compared directly with base `7612d4bb` and are inherited unchanged. The existing Agent-chat exhaustive-deps warning is also inherited. These findings are not claims of a fully clean repository-wide lint run.

Private staging env files, accounts, model caches, runtime credentials, review evidence and installer binaries remain excluded from Git. The installer fingerprints describe the recorded package build; source publication does not replace the pending unlocked macOS acceptance check or establish live Job-history/Skill-invocation acceptance.
