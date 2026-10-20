import { createPersonalConfigurationRuleRepository } from "./personal-configuration-rule-repository.js";
import { createPersonalConfigurationMembershipRepository } from "./personal-configuration-membership-repository.js";
import type pg from "pg";
import { createPersonalConfigurationRecordRepository } from "./personal-configuration-record-repository.js";
import { createPersonalConfigurationDeliveryRepository } from "./personal-configuration-delivery-repository.js";
import { createPersonalConfigurationSourceRepository } from "./personal-configuration-source-repository.js";

export const createPersonalConfigurationRepository = (pool: pg.Pool) => ({
  ...createPersonalConfigurationRecordRepository(pool),
  ...createPersonalConfigurationDeliveryRepository(pool),
  ...createPersonalConfigurationSourceRepository(pool),
  ...createPersonalConfigurationMembershipRepository(pool),
  ...createPersonalConfigurationRuleRepository(pool)
});
export type PersonalConfigurationRepository = ReturnType<
  typeof createPersonalConfigurationRepository
>;
