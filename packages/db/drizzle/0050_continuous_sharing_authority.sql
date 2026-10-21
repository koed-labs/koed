CREATE TABLE "team_memory_reason_publications" (
	"reason_id" uuid NOT NULL,
	"share_grant_id" uuid NOT NULL,
	"consent_id" uuid NOT NULL,
	"representation_id" uuid NOT NULL,
	"rule_version" integer,
	"publisher_fence" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_memory_reason_publications_reason_id_representation_id_pk" PRIMARY KEY("reason_id","representation_id"),
	CONSTRAINT "team_memory_reason_publications_fence_check" CHECK (("team_memory_reason_publications"."rule_version" is null and "team_memory_reason_publications"."publisher_fence" is null) or ("team_memory_reason_publications"."rule_version" is not null and "team_memory_reason_publications"."publisher_fence" is not null and "team_memory_reason_publications"."rule_version">0 and "team_memory_reason_publications"."publisher_fence">0))
);
--> statement-breakpoint
CREATE TABLE "team_memory_sharing_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"logical_memory_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"team_workspace_id" uuid NOT NULL,
	"maximum_fidelity" "shared_memory_representation" NOT NULL,
	"include_curated_memory" boolean DEFAULT false NOT NULL,
	"effective_privacy_policy_hash" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"authority_version" integer DEFAULT 1 NOT NULL,
	"publisher_credential_id" uuid NOT NULL,
	"publisher_fence" bigint DEFAULT 1 NOT NULL,
	"creation_mutation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stopped_at" timestamp with time zone,
	CONSTRAINT "team_memory_sharing_rules_creation_mutation_id_unique" UNIQUE("creation_mutation_id"),
	CONSTRAINT "team_memory_sharing_rules_scope_unique" UNIQUE("id","logical_memory_id","team_id","team_workspace_id"),
	CONSTRAINT "team_memory_sharing_rules_authority_check" CHECK ("team_memory_sharing_rules"."authority_version">0 and "team_memory_sharing_rules"."publisher_fence">0),
	CONSTRAINT "team_memory_sharing_rules_fidelity_check" CHECK ("team_memory_sharing_rules"."maximum_fidelity" in ('memory_events','lcm_leaves','lcm_rollups')),
	CONSTRAINT "team_memory_sharing_rules_privacy_hash_check" CHECK ("team_memory_sharing_rules"."effective_privacy_policy_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "team_memory_sharing_rules_lifecycle_check" CHECK (("team_memory_sharing_rules"."state" in ('active','paused') and "team_memory_sharing_rules"."stopped_at" is null) or ("team_memory_sharing_rules"."state"='stopped' and "team_memory_sharing_rules"."stopped_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "team_memory_representations" DROP CONSTRAINT "team_memory_representations_revision_unique";
--> statement-breakpoint
ALTER TABLE "team_memory_share_reasons" DROP CONSTRAINT "team_memory_share_reasons_kind_check";
--> statement-breakpoint
ALTER TABLE "team_memory_share_reasons" ADD COLUMN "rule_id" uuid;
--> statement-breakpoint
ALTER TABLE "team_memory_representations" ADD CONSTRAINT "team_memory_representations_consent_unique" UNIQUE("id","share_grant_id","consent_id");
--> statement-breakpoint
ALTER TABLE "team_memory_share_reasons" ADD CONSTRAINT "team_memory_share_reasons_scope_unique" UNIQUE("id","share_grant_id");
--> statement-breakpoint
ALTER TABLE "team_memory_reason_publications" ADD CONSTRAINT "team_memory_reason_publications_reason_fk" FOREIGN KEY ("reason_id","share_grant_id") REFERENCES "public"."team_memory_share_reasons"("id","share_grant_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "team_memory_reason_publications" ADD CONSTRAINT "team_memory_reason_publications_representation_fk" FOREIGN KEY ("representation_id","share_grant_id","consent_id") REFERENCES "public"."team_memory_representations"("id","share_grant_id","consent_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "team_memory_sharing_rules" ADD CONSTRAINT "team_memory_sharing_rules_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "team_memory_sharing_rules" ADD CONSTRAINT "team_memory_sharing_rules_source_owner_fk" FOREIGN KEY ("logical_memory_id","owner_user_id") REFERENCES "public"."logical_memories"("id","owner_user_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "team_memory_sharing_rules" ADD CONSTRAINT "team_memory_sharing_rules_publisher_owner_fk" FOREIGN KEY ("publisher_credential_id","owner_user_id") REFERENCES "public"."device_credentials"("id","owner_user_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "team_memory_sharing_rules" ADD CONSTRAINT "team_memory_sharing_rules_workspace_fk" FOREIGN KEY ("team_workspace_id","team_id") REFERENCES "public"."team_workspaces"("id","team_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "team_memory_sharing_rules_owner_idx" ON "team_memory_sharing_rules" USING btree ("owner_user_id","updated_at" DESC NULLS LAST);
--> statement-breakpoint
ALTER TABLE "team_memory_share_reasons" ADD CONSTRAINT "team_memory_share_reasons_rule_id_team_memory_sharing_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."team_memory_sharing_rules"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "team_memory_share_reasons_rule_unique" ON "team_memory_share_reasons" USING btree ("share_grant_id","rule_id") WHERE "team_memory_share_reasons"."kind"='rule';
--> statement-breakpoint
ALTER TABLE "team_memory_representations" ADD CONSTRAINT "team_memory_representations_revision_unique" UNIQUE("share_grant_id","consent_id","representation","source_revision","fidelity_policy_revision","content_policy_version","classifier_version","sanitized_source_preview_id");
--> statement-breakpoint
ALTER TABLE "team_memory_share_reasons" ADD CONSTRAINT "team_memory_share_reasons_kind_check" CHECK (("team_memory_share_reasons"."kind"='direct' and "team_memory_share_reasons"."rule_id" is null) or ("team_memory_share_reasons"."kind"='rule' and "team_memory_share_reasons"."rule_id" is not null));
--> statement-breakpoint
CREATE FUNCTION bind_direct_reason_publication() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO team_memory_reason_publications
    (reason_id,share_grant_id,consent_id,representation_id)
  SELECT reason.id,NEW.share_grant_id,NEW.consent_id,NEW.id
    FROM team_memory_share_reasons reason
   WHERE reason.share_grant_id=NEW.share_grant_id
     AND reason.consent_id=NEW.consent_id AND reason.kind='direct'
  ON CONFLICT (reason_id,representation_id) DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bind_direct_reason_publication
  AFTER INSERT ON team_memory_representations
  FOR EACH ROW EXECUTE FUNCTION bind_direct_reason_publication();
--> statement-breakpoint
-- Preserve only the exact consent-bound direct publications already present.
-- This does not grant access to a different revision or representation.
INSERT INTO team_memory_reason_publications
  (reason_id,share_grant_id,consent_id,representation_id)
SELECT reason.id,representation.share_grant_id,representation.consent_id,representation.id
  FROM team_memory_representations representation
  JOIN team_memory_share_reasons reason
    ON reason.share_grant_id=representation.share_grant_id
   AND reason.consent_id=representation.consent_id AND reason.kind='direct';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION bind_direct_share_reason() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- The primary grant may have first been created for a rule. Updating its
  -- source metadata must never invent a second, direct sharing authority.
  IF NEW.consent_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM team_memory_share_reasons reason
     WHERE reason.share_grant_id=NEW.id AND reason.consent_id=NEW.consent_id
       AND reason.kind='rule'
  ) THEN
    INSERT INTO team_memory_share_reasons
      (share_grant_id,consent_id,repository_snapshot,repository_snapshot_source_revision)
    VALUES (NEW.id,NEW.consent_id,NEW.repository_snapshot,NEW.repository_snapshot_source_revision)
    ON CONFLICT (share_grant_id) WHERE kind='direct' DO UPDATE
      SET consent_id=EXCLUDED.consent_id,
          repository_snapshot=EXCLUDED.repository_snapshot,
          repository_snapshot_source_revision=EXCLUDED.repository_snapshot_source_revision,
          updated_at=now();
  END IF;
  RETURN NEW;
END;
$$;
