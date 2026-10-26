# Privacy CPU runtime rollout and rollback

Tickets 01–07 qualify the Linux x64 CPU candidate. Ticket 08 requires explicit
approval for the manual deployment and its workload. These steps do not authorize
a rollout. Native and accelerator paths keep their existing support scope.

## Frozen artifact set

| Role                              | Local tag                               | Verified image identity                                                   |
| --------------------------------- | --------------------------------------- | ------------------------------------------------------------------------- |
| Matching current backend/client   | `koed:privacy-team-20261026-06`         | `sha256:eeebfa55b40eb632dfa312000448994ecb4fc43476516e99c5cc75eaa125f0cf` |
| Selected two-slot CPU service     | `koed:privacy-worker-20261026-05`       | `sha256:2db9da6d30b87a58d84c81f4162b561a1a5a7519d32f4abef9d2aab7951bbb64` |
| Previous one-slot Privacy service | `koed:manual-privacy-progress-20261023` | `sha256:4b2398b50466c8c780e7637648d2d8beafac371687bf87b1280d169402b250fa` |

The matching current client accepts exactly one or two advertised slots. Rollback
retains that backend/client and replaces the Privacy runtime with the frozen
one-slot service. It does not downgrade API/database code. Read-only fingerprints
showed identical migration files and worker sources between the old manual image
and current backend, but different API/database source files. That older full
backend is therefore not the qualified database/publication rollback target.

The selected image is built with `apps/privacy-service/Dockerfile.cpu-worker`.
The current backend is built with `packages/koed-server/Dockerfile`. Preserve the
exact retained images, model hashes, lockfile and current source diff. Local tags
are not immutable: verify every image ID before executing the steps below. No
registry publication or release is part of this package.

Use the dedicated public-only `koed-privacy-migration-models` volume. It contains
the six pinned assets with traversable directories and read-only files for User 1000. Mount it read-only; never change permissions on a deployment's original
model/home volume. The packaged inference workers receive no database or
publication credentials. Existing classification and separate control tokens
remain in the normal private deployment configuration.

## Executable Operator sequence

Run from the deployment checkout. Docker Compose 2.24.4 or newer is required for
`!override`. Supply the deployment's existing private environment file and Compose
override through the variables below. Do not print rendered Compose environment
values, regenerate keys, run model installers or alter existing mounts/data.

```bash
export KOED_TEAM_RUNTIME_IMAGE=koed:privacy-team-20261026-06
export KOED_PRIVACY_CPU_IMAGE=koed:privacy-worker-20261026-05
export KOED_PRIVACY_ROLLBACK_IMAGE=koed:manual-privacy-progress-20261023
export KOED_PRIVACY_MODEL_VOLUME=koed-privacy-migration-models
# Set these to the approved existing deployment, private env file and override:
: "${KOED_TARGET_PROJECT:?}"
: "${KOED_DEPLOYMENT_ENV_FILE:?}"
: "${KOED_DEPLOYMENT_OVERRIDE:?}"

for artifact in "$KOED_TEAM_RUNTIME_IMAGE" "$KOED_PRIVACY_CPU_IMAGE" "$KOED_PRIVACY_ROLLBACK_IMAGE"; do
  docker --context koed-vps image inspect "$artifact" --format '{{.Id}}'
done

cpu_compose() {
  docker --context koed-vps compose --env-file "$KOED_DEPLOYMENT_ENV_FILE" \
    -p "$KOED_TARGET_PROJECT" \
    -f examples/server-compose/docker-compose.yml \
    -f "$KOED_DEPLOYMENT_OVERRIDE" \
    -f examples/server-compose/privacy-cpu-worker.override.yml "$@"
}
rollback_compose() {
  docker --context koed-vps compose --env-file "$KOED_DEPLOYMENT_ENV_FILE" \
    -p "$KOED_TARGET_PROJECT" \
    -f examples/server-compose/docker-compose.yml \
    -f "$KOED_DEPLOYMENT_OVERRIDE" \
    -f examples/server-compose/privacy-cpu-worker.override.yml \
    -f examples/server-compose/privacy-cpu-rollback.override.yml "$@"
}
cpu_compose config --quiet
rollback_compose config --quiet
```

Compare the three printed image identities with the table. Record target
container IDs, current image IDs, pending-state counts, policy-denied counts and
the approved observation window before stopping anything. The original six
manual containers are the only prospective ticket 08 target; all unrelated
rootless/rootful containers and the local fixture remain unchanged.

After explicit ticket 08 approval, stop the API/worker before changing capacity,
then drain the Privacy service. Durable operations keep their original identity.

```bash
cpu_compose stop -t 20 koed-server
cpu_compose stop -t 10 privacy-service
cpu_compose up -d --no-deps --no-build privacy-service
cpu_compose exec -T privacy-service node -e \
  'fetch("http://127.0.0.1:8092/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
# Continue only after model verification and startup parity report ready.
cpu_compose up -d --no-deps --no-build koed-server
cpu_compose exec -T koed-server node -e \
  'fetch("http://127.0.0.1:3300/ready").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
```

Use the normal authenticated client to confirm `maximumConcurrentRequests=2` and
perform the approved synthetic masking probe. Health alone is not an authority
check. Confirm existing allowed/denied outcomes through normal scoped reads.
Observe normal durable retry rather than resubmitting approvals or publications.
A crash can leave a 120-second claim lease; liveness does not renew a stalled
classification deadline. Record validated progress, stages, cache reuse, service
errors, retry/failure counts and cgroup memory without source content, paths,
credentials, token IDs or logits. Finalization remains a single deployment-wide
lease even with two inference workers.

Restart uses the same stop/readiness/start ordering and preserved volumes. For a
runtime rollback, stop the backend and Privacy service, start the one-slot runtime
and verify readiness before restarting the matching current backend:

```bash
cpu_compose stop -t 20 koed-server
cpu_compose stop -t 10 privacy-service
rollback_compose up -d --no-deps --no-build privacy-service
rollback_compose exec -T privacy-service node -e \
  'fetch("http://127.0.0.1:8092/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
# Continue only after parity; the normal authenticated client must advertise one slot.
rollback_compose up -d --no-deps --no-build koed-server
```

Do not restart an older one-slot-only client while the two-slot service is running.
The qualified rollback uses the current backend/client for both runtime profiles.
No database reset, schema downgrade, key rotation, consent replacement or forced
source resubmission is needed. Invalidated results and current policy denials stay
unavailable after rollback.

## Rollback triggers and observation limits

Stop admitting work and roll back for masking/parity drift, a contract/identity
mismatch, repeated inference failure that exhausts supervised recovery, OOM, or
current-authority failure. Do not relax a fence to finish a cohort. Investigate a
sustained memory trend above 3.2 GiB within the 4 GiB cap, repeated inability to
finish legitimate inputs within their input-derived deadlines, or material latency
regression on a comparable approved cohort. Compare cache state, input sizes and
queue age before attributing a change to inference. A policy-denied operation is
not a classification performance failure.

The isolated rehearsal drained one active long request in 6.4 seconds; the caller
received `PrivacyServiceUnavailableError` without partial success. The previous
runtime passed load/parity in 10.6 seconds, advertised one slot and reproduced the
short/multi-window masking fingerprint. Cutting forward restored two slots and
exactly the same fingerprint. Both 48-item authorized reads and the policy-denied
403 remained unchanged. All four Pending Share approval/source/destination
bindings had the same aggregate fingerprint, and all 57 saved encrypted result
records retained their identity. Ticket 06 separately demonstrated actual backend
exit 137, ordinary lease recovery and reuse of seven saved classifier results.
No broad test suite, native build or benchmark matrix was repeated.

The manual deployment was inspected read-only after rehearsal: five Pending
Shares were already activated and all five Privacy targets ready. There was no
pending publication cohort to time. Ticket 08 therefore needs approval for the
rollout and a normally approved publication workload before complete-publication
performance can be reported. The service benchmark is not a substitute for that
live publication measurement.

## Approved manual deployment state

On 26 October 2026, the User approved and the Operator applied this frozen
backend/two-worker CPU artifact set to `koed-manual-20261023`. The coordinated
restart and exact authenticated masking/capacity checks passed. The ten-minute
live window completed with 298 health samples and no health/query failures.
Privacy memory stayed near 1.77 GiB, with a 1.96 GiB peak and no limit/OOM events.
The five original shares retained their binding identity and activated/ready
states. Only the approved backend and Privacy containers were replaced; four
manual dependencies retained their container IDs. The previous one-slot runtime
and matching current backend remain available as the qualified rollback set.

No new publication occurred during that initial window. The User subsequently
approved a Git Anchor share normally. Four observed member publications activated
in 8.427, 31.422, 96.074 and 105.280 seconds, and the User confirmed that a shared
conversation opens in the Team view. The cohort processed 283 fields / 24,194
bytes with 21 inference calls, no classifier failures, and the same 1.96 GiB
cgroup peak. A bounded five-minute cohort observation also passed. Final state
was nine activated shares and nine ready Privacy targets, with all five original
bindings intact. See the [complete validation record](privacy-runtime-migration-validation.md#ticket-08-approved-manual-staging).

Ticket 08 is complete for this approved cohort. There is no paired old-runtime
live-publication baseline, so the service benchmark must not be presented as a
measured publication speedup. Native/GPU qualification, whole-anchor initial
catch-up and unrelated backend-disconnect investigations remain separate.
The changeset waiver remains; no push, merge or release was performed.
