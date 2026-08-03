export const PERSONAL_DEVICE_PAIRING_PROGRESS_VERSION = 1 as const;

export type PersonalDevicePairingProgress = {
  contractVersion: typeof PERSONAL_DEVICE_PAIRING_PROGRESS_VERSION;
  requestId: string;
  state: "approval_pending";
  shortCode: string;
};

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const shortCode = /^[0-9A-F]{8}$/;

export const parsePersonalDevicePairingProgress = (
  value: unknown
): PersonalDevicePairingProgress => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Personal Device pairing progress.");
  }
  const event = value as Record<string, unknown>;
  const keys = Object.keys(event).sort();
  if (
    keys.length !== 4 ||
    keys[0] !== "contractVersion" ||
    keys[1] !== "requestId" ||
    keys[2] !== "shortCode" ||
    keys[3] !== "state" ||
    event.contractVersion !== PERSONAL_DEVICE_PAIRING_PROGRESS_VERSION ||
    typeof event.requestId !== "string" ||
    !uuid.test(event.requestId) ||
    event.state !== "approval_pending" ||
    typeof event.shortCode !== "string" ||
    !shortCode.test(event.shortCode)
  ) {
    throw new Error("Invalid Personal Device pairing progress.");
  }
  return {
    contractVersion: PERSONAL_DEVICE_PAIRING_PROGRESS_VERSION,
    requestId: event.requestId,
    state: event.state,
    shortCode: event.shortCode
  };
};
