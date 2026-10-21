ALTER TABLE "team_memory_sharing_rules" DROP CONSTRAINT "team_memory_sharing_rules_selector_check";--> statement-breakpoint
ALTER TABLE "team_memory_sharing_rules" ADD CONSTRAINT "team_memory_sharing_rules_selector_check" CHECK (
      ("team_memory_sharing_rules"."selector_kind"='captured_session' and "team_memory_sharing_rules"."logical_memory_id" is not null
        and "team_memory_sharing_rules"."selector_binding_hash" is null and "team_memory_sharing_rules"."selector_payload" is null)
      or ("team_memory_sharing_rules"."selector_kind" in ('repository','folder') and "team_memory_sharing_rules"."logical_memory_id" is null
        and "team_memory_sharing_rules"."selector_binding_hash" is not null and "team_memory_sharing_rules"."selector_binding_hash" ~ '^[a-f0-9]{64}$' and "team_memory_sharing_rules"."selector_payload" is not null)
    );