# Team continuous sharing: local candidate status

Local production release-candidate acceptance completed on 23 October 2026.
PROD-01 through PROD-06 and P2-09 through P2-14 are locally complete. The candidate
is ready for the separate release qualification and release decision below. The [production tickets](../tickets.md) and
[validation record](team-continuous-sharing-validation.md) retain the exact scope
and evidence.

Manual testing subsequently exposed a local sharing-review freshness defect
under background capture/import, followed by invisible standalone selection rules
in Shares and initial catch-up starvation. Their source corrections and focused
checks are recorded in the validation record. The artifact identities below
refer to the preceding accepted package; reassemble and verify artifacts before
including these corrections in a distributed candidate. Pi tool provenance and
exact-detail owner-preview selection are also corrected. All four original failed
publications recover through normal owner retry with unchanged candidate, consent
and canonical source bindings; authenticated owner previews and grant reads pass.
The local source-runtime and manual Team image build successfully. The packaged
artifacts below still precede these corrections and require reassembly and
qualification before distribution.

## Artifacts

| Component                 | Current identity or qualification                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Desktop                   | macOS arm64; ad-hoc development signature; refreshed package integrity passes                               |
| Team image                | `sha256:69ddd0bca42f6af0d8fd8a8d426448a61ef05d9aec05f763a5ba6634d606bdaf`                                   |
| Embedding image           | `sha256:37f001d043cb73b2660642cfae385b56ebb7d9503fb9119f71583eaf5ce68cfc`                                   |
| Current schema            | 75 migrations, ending at `0074_yellow_nightmare`                                                            |
| Runtime comparison        | All ten service/schema components match: `36d651bf1f53b5a9b9c62719004cf5803eea76c1b87ba4c6f5c3307b44feac84` |
| Desktop external renderer | 377 files; `92f4c15e08990388be3d44fddff79e024de425b0c624e040048673352e829cf9`                               |
| Desktop archive           | `f9af0e54e41dd66be195b29179e0766f69b750bef09cacb4bfb3f2a53d054b22`                                          |

The Desktop renderer is packaged outside `app.asar`; the archive hash alone does
not identify the complete app. Use the documented
[package assembly and integrity procedure](team-continuous-sharing-implementation-plan.md#candidate-assembly-and-operator-handoff).
Retain the matching encryption configuration with every encrypted backup.

## Local evidence

The enrolled native journey covers Alice on two Personal devices and Bob as a
second owner, using independent test Workspaces. It exercises Git Anchor, exact
Folder, Project and Conversation sharing, later captured turns, encrypted
Personal replication, publisher transfer, former-publisher denial, independent
reasons, pause/resume/stop, Workspace exclusion and reviewed restoration.

Snapshot conversion preserves the fixed revision until continuous publication is
ready. Detail reductions deny richer reads and recall; fresh browser approval is
required for increases. Native content-policy amendments pass in an explicitly
approved isolated restored copy. The original fixture retains every required
Privacy category. Source-only revocation denies source reads while preserving
semantic Memory. The focused processing regression also fences claimed policy
work during exclusion and resumes only after reviewed restoration.

The original native state passes encrypted same-build backup and exact comparison
of all 262 tables, followed by actual restored-service authorization checks.
Consent, independent reasons, source revocation, publication identity and publisher
fences survive. The final checkpoint includes the native snapshot-after-rule flow:
its direct snapshot stays at revision 51 while the transferred Git rule reaches
revision 55. Alice's ten and Bob's three contribution identities match exactly.
Refresh that final checkpoint after any further native mutation.

## Operator handoff

Follow the [candidate assembly procedure](team-continuous-sharing-implementation-plan.md#candidate-assembly-and-operator-handoff)
with frozen dependencies and the supported native asset input. Follow
[running Koed](running-koed.md) for native operation and the
[server Compose instructions](../examples/server-compose/README.md) for Team.
Keep the same component and current-schema state on every device and backend.
The candidate is assembled from the current working source; no release commit
or immutable source tag has been created. Freeze and record that source when a
release is authorized, then repeat artifact identity and integrity verification.

Retain the deployment encryption configuration with the encrypted archive. Use
the [backup procedure](hosted-backups.md), verify the archive, and restore only into
an explicitly named isolated target before serving it. Verify authorized and
denied reads through the restored service. Never overwrite the running source
for a restore check. The final local source fixture is resumed healthy; native
test profiles are stopped normally.

Privacy filtering can remain visible until the normal five-minute activation
retry. A pending state is not proof of failed or completed sharing. Missing
source evidence stays pending, stopped rules stay stopped, and offline stop intent
requires Team acknowledgment before remote access can be described as ended.
Keep secure credential storage enabled. A changed native build may require a new
macOS Keychain approval; approval is an OS decision and cannot be assumed to carry
over to a rebuilt application.

## Unavailable qualifications and limits

- WorkOS identity and a genuinely remote staged deployment have not been
  qualified by the local developer fixture. Do not report them as passed.
- Portable native runtime assets, Developer ID signing and notarization still
  require actual release inputs. The local Homebrew smoke assets and ad-hoc
  signature establish local operation only.
- Full test-source typechecking exceeded the 2 GB heap cap. Production builds,
  workspace typechecks and changed-test typechecks passed; no full test-source
  pass is claimed. Full lint passed through bounded invocations of the same
  configuration after a monolithic process exceeded available heap.
- GPU concurrency qualification requires its supported accelerator environment;
  the current shared local model services use CPU execution.
- Historical data, database layouts, mixed versions and earlier protocols are
  outside this current-build acceptance scope. Unavailable local-only sources
  remain pending rather than acquiring guessed portable identity.
- Docker Desktop needs free space inside its VM as well as on the host. The
  observed disk exhaustion recovered through normal database WAL recovery after
  unused build artifacts were removed; database volumes and keys were preserved.

The User's decision to omit a changeset remains in effect. A push, PR, merge,
external deployment or release publication requires a separate decision.

The later Privacy queue correction uses coordinated source and local Team
runtime builds. The packaged candidate artifacts above precede that correction;
reassemble and verify them before distributing it. Its focused checks and actual
publication recovery status are recorded in the validation record.

Before distributing or deploying, supply portable runtime assets and Developer ID
signing/notarization inputs, qualify WorkOS and the target remote deployment, and
complete accelerator qualification where GPU execution is offered. These remain
release prerequisites. Local acceptance does not establish them. Keep this
candidate status and the validation record with the release review.
