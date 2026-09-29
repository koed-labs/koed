ALTER TABLE "personal_agent_identities" DROP CONSTRAINT "personal_agent_identities_text_check";--> statement-breakpoint
ALTER TABLE "personal_agent_identity_versions" DROP CONSTRAINT "personal_agent_identity_versions_text_check";--> statement-breakpoint
ALTER TABLE "personal_agent_identities" ADD CONSTRAINT "personal_agent_identities_text_check" CHECK (length(trim("personal_agent_identities"."name")) between 1 and 128
        and length("personal_agent_identities"."role") <= 512
        and ("personal_agent_identities"."avatar_reference" is null or length("personal_agent_identities"."avatar_reference") <= 4096)
        and (("personal_agent_identities"."default_provider" is null) = ("personal_agent_identities"."default_model" is null))
        and ("personal_agent_identities"."default_provider" is null or "personal_agent_identities"."default_provider" ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){0,7}$')
        and ("personal_agent_identities"."default_model" is null or length(trim("personal_agent_identities"."default_model")) between 1 and 512)
        and ("personal_agent_identities"."default_provider" is not null or "personal_agent_identities"."default_reasoning_effort" is null)
        and ("personal_agent_identities"."default_reasoning_effort" is null or length(trim("personal_agent_identities"."default_reasoning_effort")) between 1 and 64)
        and "personal_agent_identities"."creation_request_fingerprint" ~ '^[0-9a-f]{64}$'
        and ("personal_agent_identities"."retirement_request_fingerprint" is null or "personal_agent_identities"."retirement_request_fingerprint" ~ '^[0-9a-f]{64}$')
        and ("personal_agent_identities"."restore_request_fingerprint" is null or "personal_agent_identities"."restore_request_fingerprint" ~ '^[0-9a-f]{64}$'));--> statement-breakpoint
ALTER TABLE "personal_agent_identity_versions" ADD CONSTRAINT "personal_agent_identity_versions_text_check" CHECK (length(trim("personal_agent_identity_versions"."name")) between 1 and 128
        and length("personal_agent_identity_versions"."role") <= 512
        and ("personal_agent_identity_versions"."avatar_reference" is null or length("personal_agent_identity_versions"."avatar_reference") <= 4096)
        and (("personal_agent_identity_versions"."default_provider" is null) = ("personal_agent_identity_versions"."default_model" is null))
        and ("personal_agent_identity_versions"."default_provider" is null or "personal_agent_identity_versions"."default_provider" ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){0,7}$')
        and ("personal_agent_identity_versions"."default_model" is null or length(trim("personal_agent_identity_versions"."default_model")) between 1 and 512)
        and ("personal_agent_identity_versions"."default_provider" is not null or "personal_agent_identity_versions"."default_reasoning_effort" is null)
        and ("personal_agent_identity_versions"."default_reasoning_effort" is null or length(trim("personal_agent_identity_versions"."default_reasoning_effort")) between 1 and 64)
        and "personal_agent_identity_versions"."soul_instructions" = '[koed encrypted personal agent soul]'
        and "personal_agent_identity_versions"."instruction_source" in ('generated', 'custom')
        and "personal_agent_identity_versions"."request_fingerprint" ~ '^[0-9a-f]{64}$');