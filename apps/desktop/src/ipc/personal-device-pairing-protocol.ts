export const PERSONAL_DEVICE_PAIRING_PROGRESS_VERSION = 2 as const;

export type PersonalDevicePairingProgress = {
  contractVersion: typeof PERSONAL_DEVICE_PAIRING_PROGRESS_VERSION;
  requestId: string;
  state: "connecting" | "completed";
};

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const parsePersonalDevicePairingProgress = (
  value: unknown
): PersonalDevicePairingProgress => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Personal Device pairing progress.");
  }
  const event = value as Record<string, unknown>;
  const keys = Object.keys(event).sort();
  const expectedKeys = ["contractVersion", "requestId", "state"];
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    event.contractVersion !== PERSONAL_DEVICE_PAIRING_PROGRESS_VERSION ||
    typeof event.requestId !== "string" ||
    !uuid.test(event.requestId) ||
    (event.state !== "connecting" && event.state !== "completed")
  ) {
    throw new Error("Invalid Personal Device pairing progress.");
  }
  return {
    contractVersion: PERSONAL_DEVICE_PAIRING_PROGRESS_VERSION,
    requestId: event.requestId,
    state: event.state
  };
};
