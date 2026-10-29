# Optional Privacy Filter: Mac qualification

The Mac implementation and available native checks passed on 29 October 2026.
Fresh model downloading and packaged installation passed after the User approved connections in LuLu.
Native Linux, actual CUDA, exact release-runtime downloading, and clean signing acceptance remain open.
The User requested omission of the changeset. This work does not authorize publication.

## Source and candidate identity

The work starts from Git revision `2b485a7c043ba3ceb38da3d5d7d6db791b78cacf`.
The lockfile SHA-256 is `d5911feed523c651a33de4f52e4cfdc18e3de9f846c3d42226674629d3fb7515`.
The evidence bundle records the source patch, additional files, final artifact digests, and tool outputs.
The source version remains `0.9.2` for local qualification. Published artifacts remain immutable.

The host is macOS 26.6.2 arm64, with Node 24.14.0 and pnpm 11.1.2.
Electron 39.8.10 embeds Node 22.22.1, modules ABI 140, and N-API 10.
The Node 24 build uses modules ABI 137 and N-API 10.
The Desktop app uses ad-hoc signing.
It does not establish Developer ID, notarization, Gatekeeper, or clean-Mac acceptance.

The Desktop test catalog authenticates the Mac Privacy archive.
Its deliberately unusable Linux fixture pins cannot authenticate Linux assets.
This catalog is an isolated Mac fixture, not a complete qualified release catalog.
The final frozen Mac components accompany the source snapshot for the Linux stage.
The Privacy archive is unchanged between the packaged test and those frozen Mac components.

The Mac Privacy archive SHA-256 is `3e2f679e120be4c40560ba5d312434f3a18ef6bdc7c8e2962ab871436f9362c5`.
Its canonical manifest SHA-256 is `4175ca09e3d0f62d1f11075011454e1b1a26b10785883d0098fed710595346dc`.
The final Mac Base archive SHA-256 is `e94947f15c3f409f0fc86af47eaae9b47dfe325e14ba409220588a795fd82259`.
Its manifest SHA-256 is `b0a24905b5ad94c0ed52c6b3e1215b0e70eca225516f3816eeb6951aad57a689`.
The Base component freezes before catalog embedding. Desktop authenticates its bundled Base separately.

## Payload and size results

Both size builds omit native runtime source assets and use the same toolchain and target.
Installed size counts physical regular files once and does not follow framework symlinks.
The legacy report total follows symlinks and is not the physical size used here.

| Measurement              | Baseline bytes | Final bytes | Reduction bytes |
| ------------------------ | -------------: | ----------: | --------------: |
| DMG                      |    267,988,304 | 233,070,638 |      34,917,666 |
| ZIP                      |    271,947,232 | 236,993,957 |      34,953,275 |
| Installed physical files |    819,519,609 | 694,263,750 |     125,255,859 |

The final inventory found zero Privacy-only files in archives, unpacked files, resources, or nested dependencies.
The pre-signing composition gate also passed.
The baseline contains 61,083,308 reachable Privacy-only bytes.
The shared Base assembly additionally removes 63,054,768 bytes through the existing terminal target policy.
The measured total reduction therefore cannot be attributed entirely to Privacy removal.
These sizes do not promise faster inference.

## Packaged behavior

The acceptance app derives from the final packaged app and adds Homebrew-staged native runtime assets.
Its manifests are refreshed before ad-hoc sealing.
Those native assets are development fixtures, not a qualified redistributable native release.
Each run uses an isolated profile, HOME, AI Client configuration, and no `NODE_PATH`.
Static closure checks found no unresolved Base or Privacy dependency edges.
The runs remain developer-machine evidence, not an inaccessible-checkout or clean-host guarantee.

A fresh Personal Memory profile passed supported Claude Capture Hook capture and authenticated retrieval.
The synthetic recovery phrase returned through the Personal Memory search API.
No Privacy runtime or model downloaded, and no Privacy Filter Service started.
AI Client answer synthesis was not part of this test.

The actual packaged Privacy installer rejected a substituted manifest and a corrupted archive.
Both rejections preserved the selection and occurred before model downloading or inference.
The approved fixture passed component admission through that same private installer.
The model retains its separate pinned file hashes and revision.

The first empty-cache installation failed during model download under Electron.
The same endpoint responded under Node 24, which downloaded and authenticated the complete pinned model.
Electron also timed out on a second public HTTPS host. Changing DNS order did not resolve it.
The User then approved connections in LuLu. A new empty-cache profile downloaded every pinned Privacy model file under Electron.
The packaged action completed real inference, activation, authenticated readiness, and synthetic classification.
The runtime cache also started empty. Its archive came from the authorized offline fixture because this candidate is unpublished.
This proves fresh model transfer and installation. It does not prove downloading the exact runtime from a release URL.
No certificate validation was disabled. The agent did not modify network policy.
The fresh-download checkpoint precedes the final retry-status label correction. Its provisioning backend and pinned Privacy archive are unchanged.

With that verified cache, the packaged retry ran real CPU inference, activated the generation, and started Koed.
Authenticated Privacy status reported readiness only after the allocated service port passed its checks.
The service detected the synthetic person, email address, and phone number.
Automatic macOS calibration retained CPU with `insufficient_measured_benefit` on the exercised run.
The UI describes that calibration result without claiming a CUDA failure.
Shutdown completed and stopped the owned fixture services.
Ordinary relaunch reused the authenticated generation and model without a Privacy installation action.
It reported pending service startup before returning to authenticated readiness.

The current distributed release is v0.8.1 and includes the Privacy Filter in its bundled runtime.
Its downloaded ZIP matched SHA-256 `47b6047ea4526c71a46256ef5f311d67dd2347baf676235e847c86cf085078ad`.
That release's packaged CLI started native services and captured a synthetic memory in an isolated profile.
The new Desktop installed optional Privacy assets and correctly reported pending core setup for the older native runtime.
The normal runtime-update, service-start, and integration sequence then completed.
The captured memory remained recallable, the pinned model remained usable, and classification spans matched.
The old GUI was not automated. This result covers the released packaged CLI followed by normal new Desktop.
An early harness attempt ran integration before services. The corrected sequence follows the existing Desktop setup order.

The model is `openai/privacy-filter` at revision `7ffa9a043d54d1be65afb281eddf0ffbe629385b`.
The classifier hash is `a1bbb877c8fcaea48ccfd7ab94e82bec58a0c2266b6bc7fee552b68553c43539`.
The installation probe produced masking SHA-256 `cec2fbd126b283908a7f445d8260cb268fffce2e2c9e54eacc5a1fd1d7cd35b3`.
Its ONNX profile identified `CPUExecutionProvider` kernel execution.

Native CoreML service checks passed under both Node 24 and Electron.
They covered CPU parity, explicit provider switching, idle unload/reload, and unavailable-provider rejection.
They also detected the expected person, email, and phone labels.
No CUDA device or CUDA kernel execution was available on this Mac.

## Controlled failure and regression results

The affected trust, lifecycle, provisioning, readiness, compatibility, and masking run passed 248 checks in 19 files.
The runtime selection and persisted CPU-fallback run passed 51 checks in four files.
The maintained three-module inference import policy passed its additional boundary check.
Earlier package-boundary checks passed 71 distinct cases, and the trust/store/lifecycle checks passed 98 distinct cases.
These groups overlap. They are not a sum of unique tests.
Formatting, changed-file linting, Server and Privacy builds, and Desktop typechecks passed at their recorded checkpoints.
The final retry-status correction passed 18 focused installation checks and relevant lint/typechecks.
No broad unrelated test suite ran.

Controlled CUDA fixtures cover compatibility, incompatible versions, missing tools, bounded timeout, visibility ambiguity, and explicit CPU preference.
They also cover CUDA failure, silent CPU execution, masking mismatch, and CPU inference after failure.
The fixtures cannot establish native CUDA execution.
Inference verification requires executed provider events rather than a requested provider label.

Model transfer tests cover cancellation, interrupted bodies, retry, corrupt content, abandoned partial files, and reuse of complete pinned blobs.
Provisioning tests inject network, disk-space, inference, and overlapping-operation failures.
Lifecycle checks cover ownership, active pins, downgrade rejection, atomic selection, and failed recovery.
Activation and rollback compare the expected selection while holding the lifecycle lock.
A concurrent selection change cannot be overwritten by stale rollback.

## Additional native recovery and sharing checks

An actual `SIGKILL` interrupted the packaged app during runtime staging.
Relaunch preserved the previous selection and reported incomplete installation.
Retry authenticated the runtime and model, completed inference, and activated only complete assets.
The minimal recovery profile still reported pending core setup rather than readiness.
The corrected status also distinguishes a cached runtime with a missing model from a missing runtime.

The deterministic Team fixture passed seed and validation in a new isolated native database.
It contained the documented seven Users, three Workspaces, and fourteen memories.
The production Worker could not publish the source containing synthetic private data while the filtering endpoint was unavailable.
After the installed packaged service became ready, the Worker published the sanitized source.
Carol's authorized repository read succeeded without the synthetic email or API-key canary.
Disabled-member, removed-member, and revoked-share reads remained denied.
The fixture Worker used the configured external Privacy endpoint with no local Privacy model assets.
This checks native repository authorization and materialization, not browser grant creation or multi-User GUI behavior.

A packaged external-to-local transition also passed.
External mode rejected unnecessary local installation and downloaded no Privacy assets.
The same profile in bundled-local mode offered the optional installer and activated verified assets.
It correctly retained pending core setup in the minimal profile.

## Remaining qualification

Use the exact immutable release runtime and complete catalog for the final release-URL download check.
The current Mac runtime is an authorized offline fixture, and the Linux entries in its catalog are unusable fixture pins.
Native Linux builds are needed before the complete candidate can be qualified.
Use an actual signed/notarized candidate for clean-Mac signing acceptance.
The released packaged-CLI-to-Desktop upgrade already passed with retained synthetic memory and model assets.
The old GUI was not automated. That limitation does not replace or invalidate the recorded upgrade evidence.

Ticket 08 needs native Linux x64 artifacts and CPU/fallback results.
Ticket 09 needs the colleague's actual CUDA execution and CUDA-to-CPU recovery.
The [Linux handoff](handoffs/optional-privacy-linux-qualification.md) gives the commands, identities, and required report fields.
The User can share the eventual colleague package. No message to the colleague was sent.
The release remains unqualified until the outstanding results pass for its final immutable candidate.
