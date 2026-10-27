import { describe, expect, it } from "vitest";
import {
  createPhonePairing,
  MAXIMUM_CODE_ATTEMPTS,
  PAIRING_TTL_MS,
  pairingLink
} from "./pairing.js";
import {
  createPhoneGatewayStore,
  hashPhoneToken,
  newPhoneToken
} from "./store.js";

const memorySecrets = () => {
  const values = new Map<string, string>();
  return {
    values,
    get: async (reference: string) => values.get(reference) ?? null,
    put: async (reference: string, value: string) =>
      void values.set(reference, value),
    delete: async (reference: string) => void values.delete(reference)
  };
};

describe("phone pairing", () => {
  it("redeems the QR secret once", () => {
    const pairing = createPhonePairing();
    const offer = pairing.begin();
    expect(offer.secret).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(offer.code).toMatch(/^\d{6}$/u);
    expect(pairing.redeem({ secret: offer.secret })).toBe("ok");
    expect(pairing.redeem({ secret: offer.secret })).toBe("expired");
  });

  it("withdraws the offer after too many wrong codes", () => {
    const pairing = createPhonePairing();
    const offer = pairing.begin();
    const wrong = offer.code === "000000" ? "000001" : "000000";
    for (let attempt = 1; attempt < MAXIMUM_CODE_ATTEMPTS; attempt++)
      expect(pairing.redeem({ code: wrong })).toBe("invalid");
    expect(pairing.redeem({ code: wrong })).toBe("invalid");
    expect(pairing.redeem({ code: offer.code })).toBe("expired");
  });

  it("expires after ten minutes", () => {
    let now = 1_000;
    const pairing = createPhonePairing(() => now);
    const offer = pairing.begin();
    now += PAIRING_TTL_MS;
    expect(pairing.redeem({ code: offer.code })).toBe("expired");
  });

  it("puts every address and the secret in the link, not the typed code", () => {
    const link = pairingLink({
      macName: "Studio",
      urls: ["http://192.168.1.4:47917", "http://100.70.1.2:47917"],
      secret: "s".repeat(43)
    });
    const url = new URL(link);
    expect(url.protocol).toBe("koed:");
    expect(url.searchParams.getAll("u")).toEqual([
      "http://192.168.1.4:47917",
      "http://100.70.1.2:47917"
    ]);
    expect(url.searchParams.get("s")).toBe("s".repeat(43));
  });
});

describe("phone gateway store", () => {
  it("keeps only a hash of each phone's token and finds the phone by token", async () => {
    const secrets = memorySecrets();
    const store = createPhoneGatewayStore(secrets);
    const token = newPhoneToken();
    await store.update((state) => ({
      ...state,
      enabled: true,
      phones: [
        {
          id: "6f7c3b2a-6a4f-4d55-9d43-2f3c1b2a1e10",
          name: "Pixel",
          platform: "android",
          tokenHash: hashPhoneToken(token),
          createdAt: new Date().toISOString(),
          lastSeenAt: null,
          expoPushToken: null
        }
      ]
    }));
    const raw = [...secrets.values.values()].join("");
    expect(raw).not.toContain(token);
    expect((await store.phoneForToken(token))?.name).toBe("Pixel");
    expect(await store.phoneForToken(newPhoneToken())).toBeNull();
    expect(await store.phoneForToken("not a token")).toBeNull();
  });

  it("treats a damaged record as phone access off", async () => {
    const secrets = memorySecrets();
    await secrets.put("koed-phone-gateway.v1", "{not json");
    const state = await createPhoneGatewayStore(secrets).read();
    expect(state.enabled).toBe(false);
    expect(state.phones).toEqual([]);
  });
});
