import type { AccountState } from "@koed-labs/shared/account";
import catalog from "./kin-catalog.json" with { type: "json" };
import { PixelkinAccessories } from "./vendor/index.js";

export function accountUnlockMask(state?: AccountState | null): string {
  if (
    state?.status !== "signed_in" ||
    state.stale ||
    state.details?.status !== "ready" ||
    state.profile?.id !== state.details.value.userId ||
    state.details.value.kin.catalogVersion !== catalog.version
  )
    return "0x0";
  return state.details.value.kin.unlockMask;
}

const hats = catalog.items.filter((item) =>
  PixelkinAccessories.getHat(item.id)
);

function isItemUnlocked(item: { unlockBit?: number }, mask: string) {
  if (item.unlockBit === undefined) return true;
  return (
    /^0x[0-9a-f]+$/i.test(mask) &&
    ((BigInt(mask) >> BigInt(item.unlockBit)) & 1n) === 1n
  );
}

export function availableHats(mask: string) {
  return hats.filter((item) => isItemUnlocked(item, mask));
}

export function canEquipHat(hat: string, mask: string) {
  return hat === "none" || availableHats(mask).some((item) => item.id === hat);
}

export function unlockedItemLabels(mask: string) {
  return catalog.items
    .filter(
      (item) => item.unlockBit !== undefined && isItemUnlocked(item, mask)
    )
    .map((item) => item.label);
}
