# Local Paseo relay v2 experiment

Research prototype only; not integrated with Koed, PDS, or deployment. Do not use with real data or credentials. Tests generate ephemeral keys and random session/connection IDs and exchange only synthetic strings. Both legitimate endpoints explicitly require `minimumMode: 'protected'` and check the resulting mode; failures do not fall back. Negative tests intentionally simulate legacy peers to verify rejection.

## Run

Requires Node 24, npm, network for initial install, and (for the Docker test) a working Docker daemon and image access. From this directory:

```sh
npm ci
npm test
PASEO_RELAY_RUNTIME=docker npm test
```

`npm test` starts the published `@getpaseo/relay@0.14.0` Cloudflare Durable Object adapter in Wrangler's local Workers runtime. The wrapper disables `PASEO_RELAY_UPSTREAM`, the process environment removes it, and Wrangler receives an explicit empty env file instead of local `.dev.vars` or `.env` files. The Docker variant runs upstream Elixir relay image `ghcr.io/getpaseo/paseo-relay@sha256:9d5c65d4bd2c42a85a5c8ab329f801a7db41dc4c153ca7bfba6c0857b3cdad0d` (image source revision `5f4b7636af41a85ef20200c0b7e99dd1ea2ee1f2`). Dependencies are isolated and pinned by `package-lock.json`. Neither test silently substitutes a mock relay when startup fails. Docker may need image pull and architecture emulation.

Both runtimes bind the relay's published port to `127.0.0.1`; clients connect only to that address. Wrangler runs local only. Docker rejects non-Unix endpoints and pins the selected Unix socket for run and cleanup; Docker may contact a registry to pull its image. A Unix socket can itself be forwarded to a remote daemon: the Operator must ensure it reaches a local daemon. Teardown terminates sockets and checks the Wrangler process group after SIGTERM, escalating to SIGKILL, or removes the container. Processes that leave the group are not tracked; group ID reuse and forced test-process termination can defeat cleanup. Inspect and remove any `paseo-prototype-*` container manually after forced termination. Container removal after reported success is not independently verified. Ports are selected dynamically; startup can fail if another process claims the selected port first.

## Coverage and limits

The scenario uses real v2 control and per-client data sockets, two independent clients, bidirectional synthetic messages, legacy peers, malformed and unsupported protected envelopes, modified ciphertext, replayed ciphertext, and both peer-disconnect directions. The wrong-key responder receives the actual client's hello and rejects it; a control using that responder's pinned key opens and delivers a message. Noise IK encrypts the initial message to the pinned static key, so the wrong-key responder cannot produce a valid ready for that transcript. This tests rejection at the responder, not a malicious responder producing a valid ready under a different key. The legacy-responder case requires the expected client error and terminal socket closure without opening or delivering plaintext. Other invalid-record checks require no delivery and connections beginning to close. The client factory resolves before its channel opens; the harness waits for `isOpen()`.

Protected mode authenticates the daemon key and protects records; it does **not** authenticate clients, provide Koed authorization, durable delivery, or a production trust/key-distribution model. The relay can observe connection metadata. Control messages are not protected application payloads. This is not a security audit, production-ready implementation, or evidence of deployment suitability. Tests do not cover all network failures, concurrent races, binary messages, persistence, or production operations.
