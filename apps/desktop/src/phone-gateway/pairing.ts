/**
 * Pairing a phone: one short-lived offer at a time, shown on the Mac as a QR
 * code (carrying a 256-bit secret) and, for typing by hand, a 6-digit code.
 *
 * An offer lasts ten minutes and is used once. A typed code allows five wrong
 * attempts before the offer is withdrawn, so guessing six digits is not a
 * practical way in. Redeeming either form adds the phone and returns its
 * bearer token, which is never shown on the Mac and is stored only as a hash.
 */
import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export const PAIRING_TTL_MS = 10 * 60 * 1000;
export const MAXIMUM_CODE_ATTEMPTS = 5;

export type PairingOffer = {
  secret: string;
  code: string;
  expiresAt: number;
};

export type PairingOfferView = {
  /** What the QR code encodes. */
  link: string;
  /** For typing by hand: the address and the 6-digit code. */
  code: string;
  addresses: string[];
  expiresAt: string;
};

const same = (left: string, right: string): boolean => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

export const pairingLink = (input: {
  macName: string;
  urls: readonly string[];
  secret: string;
}): string => {
  const params = new URLSearchParams();
  params.set("v", "1");
  params.set("n", input.macName.slice(0, 80));
  for (const url of input.urls) params.append("u", url);
  params.set("s", input.secret);
  return `koed://pair?${params.toString()}`;
};

export interface PhonePairing {
  begin(): PairingOffer;
  cancel(): void;
  current(): PairingOffer | null;
  /** True once, for the current offer, when the secret or code matches. */
  redeem(input: {
    secret?: string;
    code?: string;
  }): "ok" | "invalid" | "expired";
}

export const createPhonePairing = (
  now: () => number = Date.now
): PhonePairing => {
  let offer: PairingOffer | null = null;
  let failures = 0;

  const live = (): PairingOffer | null => {
    if (offer && offer.expiresAt <= now()) offer = null;
    return offer;
  };

  return {
    begin() {
      failures = 0;
      offer = {
        secret: randomBytes(32).toString("base64url"),
        code: String(randomInt(0, 1_000_000)).padStart(6, "0"),
        expiresAt: now() + PAIRING_TTL_MS
      };
      return { ...offer };
    },
    cancel() {
      offer = null;
    },
    current() {
      const value = live();
      return value ? { ...value } : null;
    },
    redeem(input) {
      const value = live();
      if (!value) return "expired";
      const ok = input.secret
        ? same(input.secret, value.secret)
        : input.code
          ? same(input.code, value.code)
          : false;
      if (ok) {
        offer = null;
        return "ok";
      }
      if (input.code && ++failures >= MAXIMUM_CODE_ATTEMPTS) offer = null;
      return "invalid";
    }
  };
};
