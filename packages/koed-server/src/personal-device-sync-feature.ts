export {
  personalDeviceSyncFeatureEnvironmentName,
  resolvePersonalDeviceSyncEnabled
} from "@koed-labs/shared";

/** CLI families that pair devices or operate Personal Device Sync. */
export const personalDeviceSyncCommandNames: readonly string[] = [
  "pair",
  "personal-sync"
];
