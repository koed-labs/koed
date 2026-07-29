import { createHash } from "node:crypto";

import { canonicalJsonStringify } from "./canonical-json.js";

export const HIGH_RISK_ACTION_GRANT_HASH_DOMAINS = {
  teamAdminScope: "koed:high-risk:team-admin-scope:v1",
  teamAdminRequest: "koed:high-risk:team-admin-request:v1",
  retentionAdminScope: "koed:high-risk:retention-admin-scope:v1",
  retentionAdminRequest: "koed:high-risk:retention-admin-request:v1",
  sharedMemoryScope: "koed:high-risk:shared-memory-scope:v1",
  sharedMemoryRequest: "koed:high-risk:shared-memory-request:v1",
  managedConversationTransferScope:
    "koed:high-risk:managed-conversation-transfer-scope:v1",
  managedConversationTransferRequest:
    "koed:high-risk:managed-conversation-transfer-request:v1"
} as const;

export type HighRiskActionGrantHashDomain =
  (typeof HIGH_RISK_ACTION_GRANT_HASH_DOMAINS)[keyof typeof HIGH_RISK_ACTION_GRANT_HASH_DOMAINS];

export const highRiskActionGrantCanonicalHash = (
  domain: HighRiskActionGrantHashDomain,
  value: unknown
): string =>
  createHash("sha256")
    .update(`${domain}\n${canonicalJsonStringify(value)}`)
    .digest("hex");
