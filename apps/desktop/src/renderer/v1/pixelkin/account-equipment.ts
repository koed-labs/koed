import type {
  AccountDesktopApi,
  AccountState
} from "@koed-labs/shared/account";
import { isItemUnlocked, PixelkinAccessories } from "@koed-labs/kin-engine";

// Only interpret server bits using the catalog agreed with the account API.
const catalogVersion = "1.1.0";

export function accountUnlockMask(state?: AccountState | null): string {
  if (
    state?.status !== "signed_in" ||
    state.stale ||
    state.details?.status !== "ready" ||
    state.profile?.id !== state.details.value.userId ||
    state.details.value.kin.catalogVersion !== catalogVersion
  )
    return "0x0";
  return state.details.value.kin.unlockMask;
}

export function gatedAdditions(
  items: readonly string[],
  saved: readonly string[]
) {
  return PixelkinAccessories.filter(
    (item) =>
      item.unlockBit !== undefined &&
      items.includes(item.id) &&
      !saved.includes(item.id)
  );
}

export async function checkNewUnlocks(
  added: ReturnType<typeof gatedAdditions>,
  account: AccountDesktopApi | undefined
) {
  if (!added.length) return;
  const mask = accountUnlockMask(await account?.getState());
  if (added.some((item) => !isItemUnlocked(item, mask)))
    throw new Error("Remove unavailable accessories before saving.");
}
