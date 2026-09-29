DO $$
DECLARE
  collision record;
BEGIN
  SELECT names.owner_user_id, names.normalized_name
    INTO collision
    FROM (
      SELECT DISTINCT owner_user_id,
             lower(regexp_replace(trim(name), '\s+', ' ', 'g')) AS normalized_name,
             agent_id
        FROM personal_agent_identity_versions
      UNION
      SELECT DISTINCT owner_user_id,
             lower(regexp_replace(trim(name), '\s+', ' ', 'g')) AS normalized_name,
             id AS agent_id
        FROM personal_agent_identities
    ) AS names
   GROUP BY names.owner_user_id, names.normalized_name
  HAVING count(DISTINCT names.agent_id) > 1
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'Personal Agent historical name collision: owner %, normalized name % is claimed by multiple agents',
      collision.owner_user_id, collision.normalized_name
      USING ERRCODE = '23505';
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE "personal_agent_name_claims" (
	"owner_user_id" uuid NOT NULL,
	"normalized_name" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_agent_name_claims_owner_name_pk" PRIMARY KEY("owner_user_id","normalized_name"),
	CONSTRAINT "personal_agent_name_claims_owner_agent_name_unique" UNIQUE("owner_user_id","agent_id","normalized_name"),
	CONSTRAINT "personal_agent_name_claims_normalized_check" CHECK ("personal_agent_name_claims"."normalized_name" = lower(regexp_replace(trim("personal_agent_name_claims"."normalized_name"), '\s+', ' ', 'g'))
        and length(trim("personal_agent_name_claims"."normalized_name")) between 1 and 128)
);
--> statement-breakpoint
INSERT INTO "personal_agent_name_claims" ("owner_user_id", "normalized_name", "agent_id")
SELECT DISTINCT names.owner_user_id, names.normalized_name, names.agent_id
  FROM (
    SELECT owner_user_id,
           lower(regexp_replace(trim(name), '\s+', ' ', 'g')) AS normalized_name,
           agent_id
      FROM personal_agent_identity_versions
    UNION
    SELECT owner_user_id,
           lower(regexp_replace(trim(name), '\s+', ' ', 'g')) AS normalized_name,
           id AS agent_id
      FROM personal_agent_identities
  ) AS names;
--> statement-breakpoint
ALTER TABLE "personal_agent_identities" DROP CONSTRAINT "personal_agent_identities_text_check";--> statement-breakpoint
ALTER TABLE "personal_agent_identity_versions" DROP CONSTRAINT "personal_agent_identity_versions_text_check";--> statement-breakpoint
ALTER TABLE "personal_agent_identities" ALTER COLUMN "default_provider" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "personal_agent_identities" ALTER COLUMN "default_model" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "personal_agent_identity_versions" ALTER COLUMN "default_provider" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "personal_agent_identity_versions" ALTER COLUMN "default_model" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "personal_agent_identities" ADD COLUMN "restore_request_id" uuid;--> statement-breakpoint
ALTER TABLE "personal_agent_identities" ADD COLUMN "restore_request_fingerprint" text;--> statement-breakpoint
ALTER TABLE "personal_agent_name_claims" ADD CONSTRAINT "personal_agent_name_claims_owner_agent_fk" FOREIGN KEY ("agent_id","owner_user_id") REFERENCES "public"."personal_agent_identities"("id","owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "personal_agent_name_claims_owner_agent_idx" ON "personal_agent_name_claims" USING btree ("owner_user_id","agent_id");--> statement-breakpoint
ALTER TABLE "personal_agent_identities" ADD CONSTRAINT "personal_agent_identities_owner_restore_request_unique" UNIQUE("owner_user_id","restore_request_id");--> statement-breakpoint
ALTER TABLE "personal_agent_identities" ADD CONSTRAINT "personal_agent_identities_text_check" CHECK (length(trim("personal_agent_identities"."name")) between 1 and 128
        and length("personal_agent_identities"."role") <= 512
        and ("personal_agent_identities"."avatar_reference" is null or length("personal_agent_identities"."avatar_reference") <= 4096)
        and (("personal_agent_identities"."default_provider" is null) = ("personal_agent_identities"."default_model" is null))
        and ("personal_agent_identities"."default_provider" is null or "personal_agent_identities"."default_provider" ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){0,7}$')
        and ("personal_agent_identities"."default_model" is null or length(trim("personal_agent_identities"."default_model")) between 1 and 512)
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
        and ("personal_agent_identity_versions"."default_reasoning_effort" is null or length(trim("personal_agent_identity_versions"."default_reasoning_effort")) between 1 and 64)
        and "personal_agent_identity_versions"."soul_instructions" = '[koed encrypted personal agent soul]'
        and "personal_agent_identity_versions"."instruction_source" in ('generated', 'custom')
        and "personal_agent_identity_versions"."request_fingerprint" ~ '^[0-9a-f]{64}$');
