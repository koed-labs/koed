# Embedding Service Runtime Benchmarks

Benchmark harness for validating the Koed Embedding Service runtime and
collecting throughput data that can inform future embedding queue-time
estimates.

The embedding benchmark intentionally measures the Koed adapter only. It is not
a legacy runtime comparison harness. The useful output is adapter throughput by
token size and client concurrency, which can later inform rough embedding queue
time estimates.

The default fixture mode is `realistic`, which varies tokens throughout each
request. This avoids accidentally measuring llama.cpp prompt reuse instead of
unrelated memory chunks. Use `FIXTURE_MODE=repeated` only when deliberately
reproducing cache behavior.

The scripts start disposable Docker containers named `koed-embedding-benchmark-*`,
write results under `benchmarks/embedding-service/artifacts/`, and remove
benchmark containers when they exit.

## Prerequisites

- Docker is running.
- A Koed embedding-service image exists locally. By default this is
  `koed-self-hosted-embedding-service:latest`.
- The Hugging Face Docker volume contains
  `Qwen3-Embedding-0.6B-Q8_0.gguf`.
- The default volume name is `koed-self-hosted_embedding-model-cache`.

## Embedding Adapter Benchmark

```bash
THREADS="8 16" \
CONCURRENCY="1 2" \
SIZES="512 1024 2048 4096 8192" \
REQUESTS_PER_SCENARIO=2 \
./benchmarks/embedding-service/run_embedding_matrix.sh
```

The embedding matrix sets `LLAMA_N_BATCH=8192`,
`LLAMA_BATCH_TOKEN_HEADROOM=8`, `LLAMA_N_UBATCH=8192`, and
`EMBEDDING_MAX_TOKENS=8000` by default. This keeps Koed adapter chunks below the
same physical batch envelope used by the supervised `llama-server` process and
avoids tokenizer edge cases where a nominal 8192-token fixture becomes 8193
tokens at model execution time.

Embedding artifacts include `measured_tokens_source` when measured-token
throughput is available. Adapter rows use
`koed_adapter_llama_server_usage`, which is the `usage.prompt_tokens` value
forwarded through the Koed adapter response.

## Reranking Validation Benchmark

Reranking is not an embedding workload. Qwen3-Reranker is served as a
query-document classifier: the request must use `/v1/rerank`, and llama-server
must run with `--embedding --pooling rank --reranking`. Only benchmark GGUF
files that contain the Qwen rerank template, rank pooling metadata,
`classifier.output_labels = ["yes", "no"]`, and `cls.output.weight`.

```bash
THREADS="8" \
CONCURRENCY="1 2" \
DOCUMENT_COUNTS="10 25" \
RERANKER_CONTEXT_PER_SLOT=8192 \
RERANKER_BATCH_SIZE=8192 \
RERANKER_UBATCH_SIZE=8192 \
RERANKER_PARALLEL=4 \
RERANKER_PROMPT_CACHE_ENABLED=true \
REQUESTS_PER_SCENARIO=3 \
./benchmarks/embedding-service/run_rerank_matrix.sh
```

If a raw GGUF path is available inside the model cache volume, pass
`RERANKER_MODEL_PATH` to benchmark raw `llama-server` `/v1/rerank` directly as
a diagnostic. The production comparison should still use the Koed adapter
because that is the supported runtime boundary.

`RERANKER_CONTEXT_PER_SLOT` is multiplied by the raw llama-server parallel slot
count to produce total `--ctx-size`. Keep `RERANKER_BATCH_SIZE` and
`RERANKER_UBATCH_SIZE` at least as large as the largest formatted rerank prompt
you intend to score; llama-server rejects longer rerank pairs instead of
silently truncating them.

## Summaries

Summarize an artifact directory:

```bash
python3 benchmarks/embedding-service/summarize_matrix.py \
  benchmarks/embedding-service/artifacts/<artifact-dir> \
  --csv benchmarks/embedding-service/artifacts/<artifact-dir>/summary.csv
```

Use `measured_tokens_per_second` where available. `tokens_per_second` is based
on the requested fixture size and remains an estimate for endpoints that do not
return prompt token usage.

## Current Production Defaults

Embedding:

```bash
LLAMA_N_CTX=8192
LLAMA_N_BATCH=8192
LLAMA_BATCH_TOKEN_HEADROOM=8
LLAMA_N_UBATCH=512
LLAMA_PARALLEL=1
```

Reranking:

```bash
RERANKER_CONTEXT_PER_SLOT=8192
RERANKER_LLAMA_N_BATCH=8192
RERANKER_LLAMA_N_UBATCH=8192
RERANKER_PARALLEL=4
RERANKER_PROMPT_CACHE_ENABLED=true
```

Important knobs to sweep:

- `LLAMA_N_THREADS`
- `LLAMA_N_BATCH`
- `LLAMA_N_UBATCH`
- `LLAMA_PARALLEL`
- `RERANKER_PARALLEL`

## Apple Metal Context Benchmark

The production-path acceleration benchmark compared the former 32K embedding
context with the 8K default on an Apple Silicon host with 16 GiB unified
memory. Both runs used the Qwen3 0.6B Q8 embedding model, an 8,192-token logical
batch, a 512-token physical microbatch, one parallel slot, synthetic
256/1,024/2,048-token Memory Event inputs, and three warm iterations. The runs
were sequential under normal Desktop load, so system-wide free-memory and swap
figures are operational pressure signals rather than isolated process metrics.

| Metric                      |    32K context |     8K context |                Change |
| --------------------------- | -------------: | -------------: | --------------------: |
| Metal peak process-tree RAM |      4,642 MiB |      2,078 MiB |                  -55% |
| Minimum system-free memory  |            19% |            40% | +21 percentage points |
| System swap change          |     +1,637 MiB |       -152 MiB | no new swapping at 8K |
| Metal warm throughput       | 1,725 tokens/s | 1,607 tokens/s |                   -7% |
| Metal startup               |       1,766 ms |       1,274 ms |                  -28% |
| Warm speedup over CPU       |          4.64x |          4.99x |            maintained |

Both configurations completed without a process failure. The minimum CPU/Metal
cosine agreement was `0.999561` in both runs. The 8K context therefore removes
about 2.5 GiB of peak Metal memory while retaining approximately 93% of warm
throughput for the measured workload.

The production runtime in this branch does not import `llama-cpp-python`, and
the benchmark-maintained direct `llama-cpp-python` embedding comparator has
been removed.
