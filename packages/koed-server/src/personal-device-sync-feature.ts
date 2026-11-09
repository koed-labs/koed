export const personalDeviceSyncFeatureEnvironmentName =
  "KOED_PERSONAL_DEVICE_SYNC_ENABLED";

/** CLI families that pair devices or operate Personal Device Sync. */
export const personalDeviceSyncCommandNames: readonly string[] = [
  "pair",
  "personal-sync"
];

/**
 * Personal Device Sync commands are opt-in for this release. Unset or empty
 * means disabled; any value other than exactly "true" or "false" is invalid.
 */
export const resolvePersonalDeviceSyncEnabled = (
  environment: NodeJS.ProcessEnv = process.env
): boolean => {
  const configured = environment[personalDeviceSyncFeatureEnvironmentName];
  if (configured === undefined || configured === "") return false;
  if (configured === "true") return true;
  if (configured === "false") return false;
  throw new Error(
    `${personalDeviceSyncFeatureEnvironmentName} must be exactly "true" or "false"`
  );
};
