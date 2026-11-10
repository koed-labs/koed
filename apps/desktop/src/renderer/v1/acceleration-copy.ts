import type { AccelerationCudaPackage } from "@koed-labs/server";

export function accelerationErrorMessage(message: string | null | undefined) {
  if (!message) return null;
  if (
    message.includes(
      "Stale or unreadable locks require stopped-runtime Operator recovery."
    )
  )
    return "Koed couldn’t stop safely; restart services and try again.";
  return message;
}

export function accelerationDiskRequirement(cuda: AccelerationCudaPackage) {
  if (cuda.requiredFreeBytes === null) return "Disk requirement unavailable";
  const required = Math.ceil(
    cuda.requiredFreeBytes / 1_048_576
  ).toLocaleString();
  return `${required} MB free disk space required${cuda.availableFreeBytes !== null && cuda.availableFreeBytes < cuda.requiredFreeBytes ? " · Not enough space available" : ""}`;
}
