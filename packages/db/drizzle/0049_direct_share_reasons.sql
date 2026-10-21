CREATE TABLE "team_memory_share_reasons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"share_grant_id" uuid NOT NULL,
	"consent_id" uuid NOT NULL,
	"kind" text DEFAULT 'direct' NOT NULL,
	"repository_snapshot" jsonb NOT NULL,
	"repository_snapshot_source_revision" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_memory_share_reasons_kind_check" CHECK ("team_memory_share_reasons"."kind" = 'direct')
);
--> statement-breakpoint
ALTER TABLE "team_memory_share_reasons" ADD CONSTRAINT "team_memory_share_reasons_share_grant_id_team_memory_share_grants_id_fk" FOREIGN KEY ("share_grant_id") REFERENCES "public"."team_memory_share_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memory_share_reasons" ADD CONSTRAINT "team_memory_share_reasons_consent_id_source_owner_representation_consents_id_fk" FOREIGN KEY ("consent_id") REFERENCES "public"."source_owner_representation_consents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "team_memory_share_reasons_direct_unique" ON "team_memory_share_reasons" USING btree ("share_grant_id") WHERE "team_memory_share_reasons"."kind" = 'direct';
--> statement-breakpoint
CREATE FUNCTION bind_direct_share_reason() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.consent_id IS NOT NULL THEN
    INSERT INTO team_memory_share_reasons
      (share_grant_id,consent_id,repository_snapshot,repository_snapshot_source_revision)
    VALUES (NEW.id,NEW.consent_id,NEW.repository_snapshot,NEW.repository_snapshot_source_revision)
    ON CONFLICT (share_grant_id) WHERE kind = 'direct' DO UPDATE
      SET consent_id=EXCLUDED.consent_id,
          repository_snapshot=EXCLUDED.repository_snapshot,
          repository_snapshot_source_revision=EXCLUDED.repository_snapshot_source_revision,
          updated_at=now();
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bind_direct_share_reason
  AFTER INSERT OR UPDATE OF consent_id,repository_snapshot,repository_snapshot_source_revision
  ON team_memory_share_grants FOR EACH ROW EXECUTE FUNCTION bind_direct_share_reason();

-- Preserve existing snapshot/continuous consent exactly; no new authority.
INSERT INTO team_memory_share_reasons
  (share_grant_id,consent_id,repository_snapshot,repository_snapshot_source_revision,created_at,updated_at)
SELECT id,consent_id,repository_snapshot,repository_snapshot_source_revision,created_at,updated_at
  FROM team_memory_share_grants WHERE consent_id IS NOT NULL;
