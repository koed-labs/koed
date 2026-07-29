import { createHash } from "node:crypto";

const commitmentDomain = "koed:collaboration-action-grant-commitment:v1\n";

export const highRiskActionGrantCommitmentHash = (secret: string): string =>
  createHash("sha256")
    .update(`${commitmentDomain}${secret}`, "utf8")
    .digest("hex");

export const highRiskActionGrantCommitment = (secret: string): string =>
  `v1:${highRiskActionGrantCommitmentHash(secret)}`;
