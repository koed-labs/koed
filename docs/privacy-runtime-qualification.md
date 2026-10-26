# Replaying Privacy service qualification

The 26 October 2026 adoption run used the following locally retained images on
`koed-vps`. They contain the exact synthetic corpus, labeled boundary cases,
qualification runner and matching supported client with their service artifact.
They contain no captured User content, database credentials or publication
authority. They are qualification wrappers, not deployment images.

| Image                                 | Immutable identity                                                        |
| ------------------------------------- | ------------------------------------------------------------------------- |
| `koed:privacy-qual-current-20261026`  | `sha256:4981792d72db133bf0864da073357599e3bb1e6615ec770256dac990b28692bd` |
| `koed:privacy-qual-engine-20261026`   | `sha256:7972ce6679df031f0325ed132d46dc0e89d991ed7c95d2f8226fec291595a622` |
| `koed:privacy-qual-combined-20261026` | `sha256:9b6508250cba48b16d3d1bfc3e4f651a10031908f1d0d84cccda486eb7551889` |
| `koed:privacy-qual-memory-20261026`   | `sha256:1e536358f04935004b4278ba49d959a26d5d2c45b898f90ab012323fbe32e6ac` |

The selected deployment candidate is separately retained as
`koed:privacy-worker-20261026-05`, identity
`sha256:2db9da6d30b87a58d84c81f4162b561a1a5a7519d32f4abef9d2aab7951bbb64`.
Its reproducible packaging is `apps/privacy-service/Dockerfile.cpu-worker`.
The qualification wrappers embed their runner at `/qualification/qualify-05.mjs`,
the 41-field corpus and saved reference metadata. Preserve these image identities
with the review artifacts; no registry publication is implied. Verify retained
tags with `docker --context koed-vps image inspect` before a replay. The complete
method and limits are in the [validation record](privacy-runtime-migration-validation.md#ticket-05-combined-service-adoption).

The dedicated `koed-privacy-migration-models` volume contains only the six public,
pinned classifier assets, with read/traverse permissions for numeric User 1000.
Every runner mounts it read-only at `/models`. It is separate from the manual
deployment's model volume. No database or other deployment volume is mounted.

Run the following comparison sequentially on the same host. It uses four CPUs,
4 GiB memory/swap, no network or host ports, a read-only root filesystem and no
additional privileges. Startup and one whole-corpus warmup are reported
separately. Each variant performs three measured passes; the combined variant
also performs two additional sustained passes. Each JSON result contains only
synthetic IDs, output fingerprints, counts and resource/timing measurements.

```bash
for variant in current-first engine-only combined current-last; do
  case "$variant" in
    current-*) image=koed:privacy-qual-current-20261026 ;;
    engine-only) image=koed:privacy-qual-engine-20261026 ;;
    combined) image=koed:privacy-qual-combined-20261026 ;;
  esac
  docker --context koed-vps run --rm --network none \
    --cpus 4 --memory 4g --memory-swap 4g --pids-limit 128 \
    --user 1000:1000 --read-only --cap-drop ALL \
    --security-opt no-new-privileges \
    --tmpfs /tmp:rw,noexec,nosuid,size=32m \
    --mount type=volume,src=koed-privacy-migration-models,dst=/models,readonly \
    "$image" "$variant"
done
```

Compare every result's 41 `fingerprints` exactly before assessing performance.
Use all six bracketing current-service samples for the baseline median, and
report both baseline medians to show drift. Short-service p95 is the nearest-rank
95th percentile of the nine short probes per variant; the combined baseline has
18 probes. Also retain ready-to-complete latency, which includes the bounded
client admission queue. Preserve each variant's actual one/two-slot capabilities;
the runner never overloads a single-slot service to manufacture an improvement.

The separate memory wrapper performs one warmup and twelve sustained passes on
the same candidate, with numeric-only Node memory observations and inference
process RSS. It makes no forced garbage-collection call. Its additional IPC
observer is used only for the memory check, outside the adoption timing samples:

```bash
docker --context koed-vps run --rm --network none \
  --cpus 4 --memory 4g --memory-swap 4g --pids-limit 128 \
  --user 1000:1000 --read-only --cap-drop ALL \
  --security-opt no-new-privileges \
  --tmpfs /tmp:rw,noexec,nosuid,size=32m \
  --mount type=volume,src=koed-privacy-migration-models,dst=/models,readonly \
  koed:privacy-qual-memory-20261026 combined memory-tail
```

The wrappers use synthetic, container-local classification/control credentials
and never connect to the manual backend. The classifier and all packages are
already present locally; runtime downloads are impossible with this network
profile. This replay does not seed fixtures, create Share Grants or authorize
deployment. Avoid running the timing variants concurrently or adding unrelated
build/benchmark work during the comparison.
