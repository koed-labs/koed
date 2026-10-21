CREATE TABLE "team_memory_reason_preparations" (
	"reason_id" uuid NOT NULL,
	"share_grant_id" uuid NOT NULL,
	"consent_id" uuid NOT NULL,
	"preview_id" uuid NOT NULL,
	"source_revision" bigint NOT NULL,
	"rule_version" integer NOT NULL,
	"consent_version" integer NOT NULL,
	"grant_version" integer NOT NULL,
	"publisher_credential_id" uuid NOT NULL,
	"publisher_fence" bigint NOT NULL,
	"effective_privacy_policy_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_memory_reason_preparations_reason_id_preview_id_pk" PRIMARY KEY("reason_id","preview_id"),
	CONSTRAINT "team_memory_reason_preparations_versions_check" CHECK ("team_memory_reason_preparations"."source_revision">=0 and "team_memory_reason_preparations"."rule_version">0 and "team_memory_reason_preparations"."consent_version">0 and "team_memory_reason_preparations"."grant_version">0 and "team_memory_reason_preparations"."publisher_fence">0),
	CONSTRAINT "team_memory_reason_preparations_privacy_hash_check" CHECK ("team_memory_reason_preparations"."effective_privacy_policy_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "team_memory_representations" ADD COLUMN "display_title" text;--> statement-breakpoint
ALTER TABLE "team_memory_reason_preparations" ADD CONSTRAINT "team_memory_reason_preparations_consent_id_source_owner_representation_consents_id_fk" FOREIGN KEY ("consent_id") REFERENCES "public"."source_owner_representation_consents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memory_reason_preparations" ADD CONSTRAINT "team_memory_reason_preparations_preview_id_shared_source_previews_id_fk" FOREIGN KEY ("preview_id") REFERENCES "public"."shared_source_previews"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memory_reason_preparations" ADD CONSTRAINT "team_memory_reason_preparations_publisher_credential_id_device_credentials_id_fk" FOREIGN KEY ("publisher_credential_id") REFERENCES "public"."device_credentials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memory_reason_preparations" ADD CONSTRAINT "team_memory_reason_preparations_reason_fk" FOREIGN KEY ("reason_id","share_grant_id") REFERENCES "public"."team_memory_share_reasons"("id","share_grant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- A grant keeps one physical identity. Its independent reasons supply the
-- consent and source binding used by publication and content authorization.
DO $$
DECLARE grant_columns text;
BEGIN
  SELECT string_agg(format('grant_row.%I',attname),',' ORDER BY attnum)
    INTO grant_columns FROM pg_attribute
   WHERE attrelid='team_memory_share_grants'::regclass AND attnum>0 AND NOT attisdropped
     AND attname NOT IN (
       'consent_id','source_revision_id','remote_replica_id',
       'source_owner_policy_id','source_owner_policy_version',
       'team_policy_id','team_policy_version','workspace_policy_id','workspace_policy_version',
       'source_capabilities','activation_representation','mode','maximum_fidelity','include_curated_memory',
       'fidelity_policy_revision','content_policy_version','classifier_version','source_revision',
       'repository_snapshot','repository_snapshot_source_revision'
     );
  EXECUTE 'CREATE VIEW team_memory_reason_grant_records AS
    SELECT reason_grant.*,binding.source_kind,binding.source_session_id,
           binding.source_note_id,binding.source_memory_event_id
    FROM (SELECT ' || grant_columns || ',
      reason.id as sharing_reason_id,reason.kind as sharing_reason_kind,reason.rule_id as sharing_rule_id,
      consent.id as consent_id,consent.remote_replica_id,
      consent.source_owner_policy_id,consent.source_owner_policy_version,
      consent.team_policy_id,consent.team_policy_version,
      consent.workspace_policy_id,consent.workspace_policy_version,
      consent.source_capabilities,consent.activation_representation,consent.mode,
      consent.maximum_fidelity,consent.include_curated_memory,
      consent.fidelity_policy_revision,consent.content_policy_version,consent.classifier_version,
      reason.repository_snapshot,reason.repository_snapshot_source_revision,
      coalesce((select representation.source_revision_id
        from team_memory_reason_publications publication
        join team_memory_representations representation on representation.id=publication.representation_id
        where publication.reason_id=reason.id and publication.consent_id=reason.consent_id
          and representation.state in (''available'',''stale'') and representation.invalidated_at is null
        order by representation.source_revision desc,representation.id desc limit 1),consent.source_revision_id) as source_revision_id,
      coalesce((select max(representation.source_revision)
        from team_memory_reason_publications publication
        join team_memory_representations representation on representation.id=publication.representation_id
        where publication.reason_id=reason.id and publication.consent_id=reason.consent_id
          and representation.state in (''available'',''stale'') and representation.invalidated_at is null),consent.source_revision) as source_revision
    FROM team_memory_share_grants grant_row
    JOIN team_memory_share_reasons reason on reason.share_grant_id=grant_row.id
    JOIN source_owner_representation_consents consent on consent.id=reason.consent_id
      and consent.logical_memory_id=grant_row.logical_memory_id
      and consent.source_owner_principal_id=grant_row.owner_principal_id
      and consent.team_id=grant_row.team_id and consent.team_workspace_id=grant_row.team_workspace_id
    ) reason_grant
    JOIN logical_memory_source_revision_bindings binding on binding.source_revision_id=reason_grant.source_revision_id';
END $$;
--> statement-breakpoint
DO $$
DECLARE representation_columns text;
BEGIN
  SELECT string_agg(CASE WHEN attname IN ('source_kind','source_session_id','source_note_id','source_memory_event_id')
    THEN format('binding.%I',attname) ELSE format('representation.%I',attname) END,',' ORDER BY attnum)
    INTO representation_columns FROM pg_attribute
   WHERE attrelid='team_memory_representation_records'::regclass AND attnum>0 AND NOT attisdropped;
  EXECUTE 'CREATE OR REPLACE VIEW team_memory_representation_records AS SELECT ' || representation_columns ||
    ',representation.display_title FROM team_memory_representations representation
     JOIN logical_memory_source_revision_bindings binding ON binding.source_revision_id=representation.source_revision_id';
END $$;
--> statement-breakpoint
-- A title belongs to the exact published revision, including retained snapshots.
UPDATE team_memory_representations representation SET display_title=grant_row.display_title
  FROM team_memory_share_grants grant_row
 WHERE representation.share_grant_id=grant_row.id
   AND representation.consent_id=grant_row.consent_id
   AND representation.source_revision=grant_row.display_title_source_revision
   AND representation.state IN ('available','stale') AND representation.invalidated_at IS NULL;
