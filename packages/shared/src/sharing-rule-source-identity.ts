import { personalSourceReferenceSchema } from "./personal-source-contract.js";
import { canonicalJsonDigest } from "./canonical-json-digest.js";

/** The local owner ID changes across Personal devices. The authenticated Team
 * owner supplies the ownership boundary when deriving the private lookup key. */
export const sharingRuleSourceIdentitySchema =
  personalSourceReferenceSchema.omit({
    ownerUserId: true
  });

export type SharingRuleSourceIdentity = ReturnType<
  typeof sharingRuleSourceIdentitySchema.parse
>;

export const sharingRuleSourceIdentityHash = (
  teamOwnerUserId: string,
  identity: SharingRuleSourceIdentity
) =>
  canonicalJsonDigest({
    version: 1,
    teamOwnerUserId,
    source: sharingRuleSourceIdentitySchema.parse(identity)
  });
