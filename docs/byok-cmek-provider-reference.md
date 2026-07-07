# BYOK And CMEK Provider References

BYOK and CMEK are customer-controlled KMS provider modes. They are not aliases
for `local_test_key`, and they must not store raw customer key material in
ordinary Koed app tables, logs, diagnostics, status endpoints, support bundles,
or audit metadata.

## Supported Provider Reference

The provider reference is deployment configuration:

- `API_ENVELOPE_ENCRYPTION_PROVIDER=byok` or `cmek`
- `MANAGED_KMS_KEY_ID`
- `MANAGED_KMS_KEY_VERSION`
- `MANAGED_KMS_ENDPOINT_URL`
- `MANAGED_KMS_AUTH_TOKEN`

`MANAGED_KMS_KEY_ID` and `MANAGED_KMS_KEY_VERSION` are safe references. The
endpoint credential is deployment secret material. It must live in the
deployment secret manager, not in database rows or client-visible config.

## Onboarding Flow

1. Customer and Operator agree whether the mode is BYOK or CMEK.
2. Customer supplies either imported key material to the KMS boundary (BYOK) or
   an external customer-managed key reference (CMEK). Koed stores only the
   provider mode and safe key reference.
3. Operator configures the provider reference through deployment secrets.
4. API and Worker start with `API_ENVELOPE_ENCRYPTION_PROVIDER` set to the
   selected mode. Missing key id/version/endpoint/token must fail startup.
5. Operator checks `/ops/status`; it may show provider mode, key id, key
   version, and redacted health, but never the endpoint token or raw key
   material.
6. Operator runs a bounded encrypted write/read smoke test and then
   `pnpm hosted:encryption-rewrap --dry-run`.

## Rotation

Rotation changes `MANAGED_KMS_KEY_VERSION` to the new customer-controlled key
version and then runs `pnpm hosted:encryption-rewrap` in bounded batches. Rewrap
updates wrapped DEKs and envelope metadata without rewriting plaintext payload
bytes.

## Revocation And Unavailable Keys

If BYOK or CMEK key access is revoked, suspended, unreachable, or denied by the
provider, decrypt-dependent operations fail closed. Non-secret status,
capability, audit, and policy metadata remains available so Operators can see
that the data is unavailable because the customer-controlled key cannot be
used.

## Support Boundary

Support and export packages must use the encrypted package envelope. Package
manifests may include provider mode, key id, key version, object class, counts,
checksums, timestamps, and scope. They must not include raw Memory, prompts,
transcripts, source payloads, cookies, API Tokens, device secrets, provider
tokens, raw DEKs, raw customer keys, database URLs, or plaintext-equivalent
vectors.
