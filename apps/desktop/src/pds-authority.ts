/**
 * Reference used to store/resolve the PDS Authority key in the Desktop
 * secret store. Minting and legacy-state fail-closed handling now live
 * server-side, in createPdsSecureRuntimeForApiStartup
 * (apps/api/src/personal-device-sync/secure-runtime.ts), which can check
 * for an existing Personal Device Group in the database before deciding
 * whether it is safe to mint a replacement key. That check is
 * backend-agnostic, so it covers installations upgrading from any prior
 * secret storage (Electron safeStorage, keytar, WSL/DPAPI), not just the
 * single Electron pds-secrets.json path this module used to check.
 */
export const PDS_DESKTOP_AUTHORITY_SECRET_REFERENCE = "pds-authority";
