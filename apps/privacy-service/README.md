# Privacy Service

An isolated local HTTP service for schema-aware classification and masking with
the fixed OpenAI Privacy Filter taxonomy. The production adapter uses the
low-level `@huggingface/transformers` tokenizer and token-classification model,
then decodes its raw 33-way token logits with the in-package constrained BIOES
Viterbi decoder. Deterministic credential patterns are unioned with model spans.

## API

`GET /health` is content-free and unauthenticated. `POST /v1/classify` requires
`x-koed-privacy-token` and accepts only this versioned schema:

```json
{
  "schemaVersion": 1,
  "inputContractVersion": "koed-privacy-classification-v1",
  "fields": [{ "path": "memory.summary", "text": "Email Ada@example.test" }]
}
```

Each returned field contains `maskedText`, input identity, and non-overlapping
spans with canonical `startByte`/`endByte` UTF-8 offsets. Typed placeholders
appear in `maskedText`. The response includes the pinned model revision and
classifier hash, and never returns the detected plaintext.

Inference uses one 256-token output core at a time with 128 tokens of context
on each side (at most 512 model-input tokens). Calls are serialized per runtime,
fields are processed sequentially, and a field may contain at most 128,000
tokens.

`PRIVACY_RUNTIME_PROVIDER` accepts `cpu`, `auto`, `cuda`, `coreml`, or `dml`
and inherits Koed's product-level Hardware acceleration preference in
bundled-local operation. It therefore defaults to `auto` there, while an
explicit service value remains an Operator override.
Provider candidates are platform hints, not availability claims. Activation
loads the pinned model, checks final masking parity against the active runtime,
and calibrates warm inference before switching atomically. The authenticated
`GET /v1/runtime/status` and `POST /v1/runtime/provider` routes expose and
control only the Privacy Filter runtime; they do not alter Embedding Service
acceleration. They require the separate `PRIVACY_RUNTIME_CONTROL_TOKEN`; the
Worker's classification credential cannot switch providers.

Accelerated providers unload the model after five idle minutes by default and
reload it on the next classification. Set
`PRIVACY_GPU_IDLE_UNLOAD_SECONDS=0` to retain it. CPU inference is unaffected.

Install the workspace, build Koed Server, install the pinned model into the
Koed-owned Transformers cache, then start the service with separate
classification and runtime-control credentials:

```bash
pnpm install
pnpm --filter @koed/koed-server build
pnpm models:install:privacy
pnpm --filter @koed/privacy-service build
export KOED_PRIVACY_TRANSFORMERS_CACHE="${KOED_HOME:-$HOME/.koed}/models/privacy/transformers-cache"
export PRIVACY_SERVICE_TOKEN="$(openssl rand -base64 32)"
export PRIVACY_RUNTIME_CONTROL_TOKEN="$(openssl rand -base64 32)"
pnpm --filter @koed/privacy-service start
```

`KOED_HOME` defaults to `~/.koed`. When starting the service separately from
Koed Server, configure the Worker and Operator status checks with the same
exported credentials.
