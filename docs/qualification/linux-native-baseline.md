# Linux native runtime baseline

Ticket 01 measurements were collected on 2026-11-04. The
[machine-readable report](linux-native-baseline-2026-11-04.json) records exact
sizes, digests, versions, symlink targets, host details, and acceptance limits.
No CUDA binary ran. Existing containers on `koed-vps` remained untouched.

## Environment and method

The measurement used a new Ubuntu 22.04.5 x64 container with glibc 2.35,
four CPU cores, and a 6 GiB memory limit. The container had no host mounts,
published ports, or GPU devices. Node 24.13.1 ran the published v0.10.3 npm
artifact outside the checkout. Base used the matching published manifest pin.

Homebrew and model caches started empty. The CLI, Base archive, and Base
manifest were downloaded once, digest-verified, and installed from local files.
The runtime and model commands performed their own downloads. The report
counts the retained input archives separately from installed files and caches.

System prerequisites were `ca-certificates`, `curl`, `git`, `build-essential`,
`procps`, `python3`, `file`, `xz-utils`, `unzip`, `libgomp1`, `libnuma1`, and
`sudo`. Ubuntu and prerequisite installation costs are outside the product total.
Node and Homebrew bootstrap costs are reported separately. Optional Privacy
and CUDA payloads are outside the required CPU total.

## Measured sizes

| Payload                           | Compressed bytes |        Regular-file bytes |
| --------------------------------- | ---------------: | ------------------------: |
| Published combined native archive |      734,753,331 | See the split inventories |
| CPU split                         |       23,765,976 |                56,304,649 |
| CUDA split, packaging only        |      710,992,929 |             1,467,391,264 |

The CPU archive is below the provisional 50 MB compressed budget. Its unpacked
tree exceeds 50 MB. Review found Postgres, llama.cpp shared libraries, and CPU
architecture variants among the largest files. The split retains the existing
payload contents. No further pruning was needed to establish this baseline.

The complete Homebrew CPU download payload is 1,051,343,911 bytes. This includes
the npm package, Base archive and manifest, model, Homebrew bottles, and bottle
manifests. The model alone is 639,150,592 bytes. Separate Homebrew index traffic
and transport overhead are not archive payload bytes.

The container received 1,058,802,458 network bytes during runtime and model
installation. This includes protocol overhead and index requests. The npm,
Base, and Base manifest downloads preceded that interval and total 21,595,074
content bytes. Do not compare interface traffic directly with archive totals.

Final allocated disk use was 2,797,326,336 bytes, including Homebrew bootstrap,
caches, and retained CPU input archives. The sampled peak was 2,797,334,528
bytes. Additional peak use after the initial bootstrap was 2,667,016,192 bytes.
Samples were two seconds apart during runtime installation and 0.2 seconds
apart during Base installation. The sampled peak is a lower bound, not a
filesystem high-water mark.

Node downloaded 31,008,136 archive bytes and used 208,445,440 allocated bytes
after extraction. Its checksum list added 2,967 bytes. Homebrew bootstrap
received 24,152,599 network bytes and used 130,244,608 allocated bytes,
including its initial cache. These are separate prerequisites.

The proposed complete CPU payload totals 684,511,642 bytes provisionally:
the same npm package, Base, manifest, model, and the measured CPU split.
This is a forecast, not measured installation savings. Tickets 05 and 07
must measure the actual release-provider installation under matching conditions.
New native metadata can change the forecast.

## Selection and extraction evidence

The probe composed `runtime/native/current` with a selection containing
Postgres, the llama.cpp launcher, and the CPU payload. The existing
`runtime/postgres` and `runtime/llama.cpp` entry links reached that selection.
Postgres initialization, pgvector 0.8.3, pgcrypto 1.3, shutdown, and restart
passed through those links. CPU inference returned two finite, nonzero
1,024-dimensional vectors from the installed pinned model.

Postgres client tools initially failed to locate `libpq.so.5`. A scoped
`LD_LIBRARY_PATH=<selected-runtime>/postgres/lib` resolved the failure.
Ticket 05 must supply this environment for native processes, or ticket 03
must establish equivalent relative loader paths. Do not change global library
configuration to mask this requirement.

The existing validator passed all 98 CPU-tree loader checks, executable checks,
content checks, and Postgres extension checks with that environment. It skipped
its checkout-dependent packaged-provider check. This result does not qualify
the future release provider. The launcher selected CPU under `auto` and `cpu`.
An absent CUDA payload produced exit 69 without executing CUDA code.

The archive contains 32 relative library symlinks: 18 in the core and 14 in
CUDA. The JSON report lists every target. The existing component extractor
refused the actual CPU split with `Package archives must not contain symbolic links.`
Ticket 05 needs a separate native extraction boundary. Keep component extraction
strict. Native extraction must reject escaping paths, link chains, absolute
links, hard links, duplicates, special files, and writes through symlinked parents.

The standard Homebrew installation used PostgreSQL 17.11_1, pgvector 0.8.7,
llama.cpp 0.8.0, and ggml 0.29.0. Its device listing showed only OpenBLAS.
This result establishes no CUDA device through this standard Homebrew path.
It says nothing about custom builds or explicit binary overrides.

## Reproduction and remaining pins

Verify the published combined archive against its recorded digest before extraction.
Use a separate directory for the extracted input. Run this measurement command
from the checkout root, with the actual verified input path:

```bash
node scripts/native-runtime/measure-linux-split.mjs \
  --runtime-root /absolute/path/to/verified/koed-runtime \
  --out-dir scratch/linux-native-split
```

The output directory must not exist. The command packages both splits and
writes their inventories. It executes neither payload. These measurement
archives are not release candidates because they lack independent native
identity and contract metadata.

Repackaging the same frozen CPU tree produced the same SHA-256:
`9bdca6ff1acf41ed3f5ff05819653e34cc5c0dcede2a55522906a7dcd89fdae9`.
This proves packaging repeatability on the recorded host, not identical fresh
compilations. Source archive digests already pin Postgres, pgvector, and llama.cpp.
The independent recipe must also pin compiler and linker identities, build
flags, system-library inputs, source/build scripts, launcher code, gzip policy,
and the baseline build image. CUDA additionally needs its toolkit patch,
compiler, supported GPU architectures, and redistributable library identities.
Unrelated Postgres inputs must not affect the CUDA identity.
