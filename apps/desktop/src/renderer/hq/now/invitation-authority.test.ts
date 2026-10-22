import { describe, expect, it } from "vitest";
import { sameInvitationAuthority } from "./invitation-authority.js";

const prior: (string | null)[] = [
  "local-owner",
  "backend|generation|https://remote.example",
  "local-owner",
  null,
  "backend",
  "https://remote.example"
];
const key = (values: unknown[]) => JSON.stringify(values);

describe("accepted invitation authority", () => {
  it("allows only first Team-principal establishment under unchanged local and remote identity", () => {
    const established = [...prior];
    established[3] = "remote-principal";
    expect(
      sameInvitationAuthority(key([...prior]), key(established), true)
    ).toBe(true);
    expect(
      sameInvitationAuthority(key([...prior]), key(established), false)
    ).toBe(false);
    for (const [index, replacement] of [
      [0, "other-local-owner"],
      [1, "backend|other-generation|https://remote.example"],
      [2, "other-local-owner"],
      [4, "other-backend"],
      [5, "https://other.example"]
    ] as const) {
      const switched = [...established];
      switched[index] = replacement;
      expect(
        sameInvitationAuthority(key([...prior]), key(switched), true)
      ).toBe(false);
    }
    const switchedPrincipal = [...established];
    switchedPrincipal[3] = "different-principal";
    expect(
      sameInvitationAuthority(key(established), key(switchedPrincipal), true)
    ).toBe(false);
    expect(
      sameInvitationAuthority(key(established), key(established), true)
    ).toBe(true);
    expect(sameInvitationAuthority(key([...prior]), null, true)).toBe(false);
  });
});
