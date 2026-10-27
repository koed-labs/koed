-- Frozen schema-only reconstruction of the exact unreleased 0076 layout.
-- Used only by preservation/rejection tests; current application code never reads it.
-- Historical Project upgrade records.
CREATE TABLE "personal_legacy_project_aliases" (
	"owner_user_id" uuid NOT NULL,
	"profile_identity" text NOT NULL,
	"legacy_alias" text NOT NULL,
	"project_id" uuid NOT NULL,
	"upgrade_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_legacy_project_aliases_pk" PRIMARY KEY("owner_user_id","profile_identity","legacy_alias")
);
--> statement-breakpoint
CREATE TABLE "personal_project_upgrade_items" (
	"item_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"upgrade_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"legacy_key" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"proposal" jsonb NOT NULL,
	"project_id" uuid,
	"local_session_id" uuid,
	"state" text DEFAULT 'prepared' NOT NULL,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"applied_revision_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_upgrade_items_source_unique" UNIQUE("upgrade_id","kind","legacy_key"),
	CONSTRAINT "personal_upgrade_items_kind_check" CHECK ("personal_project_upgrade_items"."kind" in ('catalog','direct','rule','source_repair')),
	CONSTRAINT "personal_upgrade_items_state_check" CHECK ("personal_project_upgrade_items"."state" in ('prepared','needs_repair','applied','skipped')),
	CONSTRAINT "personal_upgrade_items_version_check" CHECK ("personal_project_upgrade_items"."version">0),
	CONSTRAINT "personal_upgrade_items_issues_check" CHECK (jsonb_typeof("personal_project_upgrade_items"."issues")='array')
);
--> statement-breakpoint
CREATE TABLE "personal_project_upgrades" (
	"upgrade_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"profile_identity" text NOT NULL,
	"catalog_hash" text NOT NULL,
	"catalog" jsonb NOT NULL,
	"state" text DEFAULT 'prepared' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"ownership_confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_project_upgrades_manifest_unique" UNIQUE("owner_user_id","profile_identity","catalog_hash"),
	CONSTRAINT "personal_project_upgrades_owner_id_unique" UNIQUE("owner_user_id","upgrade_id"),
	CONSTRAINT "personal_project_upgrades_state_check" CHECK ("personal_project_upgrades"."state" in ('prepared','applying','needs_repair','ready_for_activation','complete')),
	CONSTRAINT "personal_project_upgrades_version_check" CHECK ("personal_project_upgrades"."version">0)
);
--> statement-breakpoint
ALTER TABLE "personal_legacy_project_aliases" ADD CONSTRAINT "personal_legacy_alias_owned_project_fk" FOREIGN KEY ("owner_user_id","project_id") REFERENCES "public"."personal_named_projects"("owner_user_id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_legacy_project_aliases" ADD CONSTRAINT "personal_legacy_alias_owned_upgrade_fk" FOREIGN KEY ("owner_user_id","upgrade_id") REFERENCES "public"."personal_project_upgrades"("owner_user_id","upgrade_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_project_upgrade_items" ADD CONSTRAINT "personal_upgrade_items_owned_job_fk" FOREIGN KEY ("owner_user_id","upgrade_id") REFERENCES "public"."personal_project_upgrades"("owner_user_id","upgrade_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_project_upgrades" ADD CONSTRAINT "personal_project_upgrades_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "personal_legacy_alias_project_idx" ON "personal_legacy_project_aliases" USING btree ("owner_user_id","project_id");--> statement-breakpoint
CREATE INDEX "personal_upgrade_items_owner_page_idx" ON "personal_project_upgrade_items" USING btree ("owner_user_id","upgrade_id","item_id");--> statement-breakpoint
-- A resumed import may advance status, but cannot rewrite the evidence it reviewed.
CREATE FUNCTION personal_project_upgrade_evidence_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'personal_project_upgrades' THEN
    IF ROW(NEW.upgrade_id,NEW.owner_user_id,NEW.profile_identity,NEW.catalog_hash,NEW.catalog)
      IS DISTINCT FROM ROW(OLD.upgrade_id,OLD.owner_user_id,OLD.profile_identity,OLD.catalog_hash,OLD.catalog) THEN
      RAISE EXCEPTION 'Personal Project upgrade catalog evidence is immutable';
    END IF;
    IF OLD.ownership_confirmed_at IS NOT NULL AND NEW.ownership_confirmed_at IS DISTINCT FROM OLD.ownership_confirmed_at THEN
      RAISE EXCEPTION 'Personal Project upgrade owner confirmation is immutable';
    END IF;
  ELSE
    IF ROW(NEW.item_id,NEW.owner_user_id,NEW.upgrade_id,NEW.kind,NEW.legacy_key,NEW.evidence,NEW.proposal)
      IS DISTINCT FROM ROW(OLD.item_id,OLD.owner_user_id,OLD.upgrade_id,OLD.kind,OLD.legacy_key,OLD.evidence,OLD.proposal) THEN
      RAISE EXCEPTION 'Personal Project upgrade item evidence is immutable';
    END IF;
    IF OLD.state IN ('applied','skipped') AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'Settled Personal Project upgrade items are immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER personal_project_upgrade_catalog_immutable
BEFORE UPDATE ON personal_project_upgrades
FOR EACH ROW EXECUTE FUNCTION personal_project_upgrade_evidence_immutable();
--> statement-breakpoint
CREATE TRIGGER personal_project_upgrade_item_immutable
BEFORE UPDATE ON personal_project_upgrade_items
FOR EACH ROW EXECUTE FUNCTION personal_project_upgrade_evidence_immutable();
--> statement-breakpoint
CREATE TRIGGER personal_legacy_project_alias_immutable
BEFORE UPDATE ON personal_legacy_project_aliases
FOR EACH ROW EXECUTE FUNCTION personal_membership_change_immutable();
--> statement-breakpoint

-- Historical Project upgrade reviews.
CREATE TABLE "personal_project_upgrade_reviews" (
	"review_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"upgrade_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"expected_state" jsonb NOT NULL,
	"decision" jsonb NOT NULL,
	"preview" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "personal_project_upgrade_items" ADD CONSTRAINT "personal_upgrade_items_owned_id_unique" UNIQUE("owner_user_id","upgrade_id","item_id");
--> statement-breakpoint
ALTER TABLE "personal_project_upgrade_reviews" ADD CONSTRAINT "personal_upgrade_reviews_owned_item_fk" FOREIGN KEY ("owner_user_id","upgrade_id","item_id") REFERENCES "public"."personal_project_upgrade_items"("owner_user_id","upgrade_id","item_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "personal_upgrade_reviews_owner_job_idx" ON "personal_project_upgrade_reviews" USING btree ("owner_user_id","upgrade_id");--> statement-breakpoint
-- Review evidence remains immutable after apply; only the first apply timestamp may change.
CREATE FUNCTION personal_project_upgrade_review_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.review_id,NEW.owner_user_id,NEW.upgrade_id,NEW.item_id,NEW.expected_state,NEW.decision,NEW.preview,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.review_id,OLD.owner_user_id,OLD.upgrade_id,OLD.item_id,OLD.expected_state,OLD.decision,OLD.preview,OLD.created_at)
    OR (OLD.applied_at IS NOT NULL AND NEW.applied_at IS DISTINCT FROM OLD.applied_at) THEN
    RAISE EXCEPTION 'Personal Project upgrade review evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER personal_project_upgrade_review_immutable_update
BEFORE UPDATE ON personal_project_upgrade_reviews
FOR EACH ROW EXECUTE FUNCTION personal_project_upgrade_review_immutable();
--> statement-breakpoint
CREATE INDEX personal_upgrade_session_evidence_idx ON personal_project_upgrade_items
  (owner_user_id,upgrade_id,(evidence->>'sessionId'),(evidence->>'assignmentVersion')) WHERE kind='direct';
--> statement-breakpoint
CREATE INDEX personal_upgrade_route_evidence_idx ON personal_project_upgrade_items
  (owner_user_id,upgrade_id,(evidence->'route'->>'sourceProjectId')) WHERE kind='rule';
--> statement-breakpoint

-- Historical Project profile ownership.
CREATE TABLE "personal_project_profile_owners" (
	"profile_identity" text PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "personal_project_profile_owners" ADD CONSTRAINT "personal_project_profile_owners_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Existing confirmations must agree; a migration cannot choose an account by age.
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM personal_project_upgrades WHERE ownership_confirmed_at IS NOT NULL
    GROUP BY profile_identity HAVING count(DISTINCT owner_user_id)>1) THEN
    RAISE EXCEPTION 'Legacy Project profile has conflicting confirmed owners; explicit repair is required';
  END IF;
END;
$$;
--> statement-breakpoint
INSERT INTO personal_project_profile_owners(profile_identity,owner_user_id)
SELECT profile_identity,min(owner_user_id::text)::uuid FROM personal_project_upgrades
WHERE ownership_confirmed_at IS NOT NULL GROUP BY profile_identity;
--> statement-breakpoint
CREATE FUNCTION personal_project_upgrade_profile_owner_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ownership_confirmed_at IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM personal_project_profile_owners p WHERE p.profile_identity=NEW.profile_identity AND p.owner_user_id=NEW.owner_user_id
  ) THEN
    RAISE EXCEPTION 'Legacy Project profile owner is not confirmed';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER personal_project_upgrade_profile_owner_check
BEFORE INSERT OR UPDATE ON personal_project_upgrades
FOR EACH ROW EXECUTE FUNCTION personal_project_upgrade_profile_owner_check();
--> statement-breakpoint
CREATE TRIGGER personal_project_profile_owner_immutable
BEFORE UPDATE ON personal_project_profile_owners
FOR EACH ROW EXECUTE FUNCTION personal_membership_change_immutable();
--> statement-breakpoint

CREATE TABLE "personal_model_activations" (
	"owner_user_id" uuid PRIMARY KEY NOT NULL,
	"upgrade_id" uuid NOT NULL,
	"contract_version" integer NOT NULL,
	"activated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_model_activation_version_check" CHECK ("personal_model_activations"."contract_version">0)
);
--> statement-breakpoint
ALTER TABLE "personal_model_activations" ADD CONSTRAINT "personal_model_activations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_model_activations" ADD CONSTRAINT "personal_model_activation_owned_upgrade_fk" FOREIGN KEY ("owner_user_id","upgrade_id") REFERENCES "public"."personal_project_upgrades"("owner_user_id","upgrade_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE TRIGGER personal_model_activation_immutable BEFORE UPDATE ON personal_model_activations
FOR EACH ROW EXECUTE FUNCTION personal_membership_change_immutable();
CREATE TABLE "personal_project_routes" (
	"owner_user_id" uuid NOT NULL,
	"source_project_id" text NOT NULL,
	"target_project_id" text NOT NULL,
	"target_name" text NOT NULL,
	"target_path" text,
	"target_identity" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_project_routes_owner_user_id_source_project_id_pk" PRIMARY KEY("owner_user_id","source_project_id"),
	CONSTRAINT "personal_project_routes_distinct_check" CHECK ("personal_project_routes"."source_project_id" <> "personal_project_routes"."target_project_id" and "personal_project_routes"."source_project_id" <> 'unassigned')
);
ALTER TABLE "personal_project_routes" ADD CONSTRAINT "personal_project_routes_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE FUNCTION personal_legacy_route_write_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM users WHERE id=OLD.owner_user_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Legacy Project routing writes are retired; use Project inclusion rules';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER personal_legacy_route_write_guard BEFORE INSERT OR UPDATE OR DELETE ON personal_project_routes
FOR EACH ROW EXECUTE FUNCTION personal_legacy_route_write_guard();
--> statement-breakpoint
CREATE FUNCTION personal_model_activation_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM personal_project_upgrades u WHERE u.owner_user_id=NEW.owner_user_id
    AND u.upgrade_id=NEW.upgrade_id AND u.state='complete' AND u.ownership_confirmed_at IS NOT NULL)
    OR EXISTS(SELECT 1 FROM sessions s WHERE s.owner_user_id=NEW.owner_user_id AND s.visibility='personal' AND s.project_override_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Personal activation requires a completed owned upgrade and retired source roles';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER personal_model_activation_guard BEFORE INSERT ON personal_model_activations
FOR EACH ROW EXECUTE FUNCTION personal_model_activation_guard();

ALTER TABLE pending_sharing_rule_admissions RENAME CONSTRAINT pending_sharing_rule_admissions_pkey TO pending_conversation_sharing_rules_pkey;
