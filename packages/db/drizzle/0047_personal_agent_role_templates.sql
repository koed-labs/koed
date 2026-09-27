CREATE TABLE "personal_agent_role_template_versions" (
	"template_id" text NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"role" text NOT NULL,
	"soul_instructions" text NOT NULL,
	"content_sha256" text NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_agent_role_template_versions_pk" PRIMARY KEY("template_id","version"),
	CONSTRAINT "personal_agent_role_template_versions_id_check" CHECK ("template_id" ~ '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$'),
	CONSTRAINT "personal_agent_role_template_versions_text_check" CHECK ("version" > 0 and length(trim("title")) between 1 and 128 and length(trim("role")) between 1 and 160 and length(trim("soul_instructions")) between 1 and 65536 and "content_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE FUNCTION reject_personal_agent_role_template_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'published Personal Agent role template versions are immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER personal_agent_role_template_versions_immutable_trigger
BEFORE UPDATE OR DELETE ON personal_agent_role_template_versions
FOR EACH ROW EXECUTE FUNCTION reject_personal_agent_role_template_mutation();
--> statement-breakpoint
ALTER TABLE "personal_agent_identity_versions" ADD COLUMN "source_template_id" text;
--> statement-breakpoint
ALTER TABLE "personal_agent_identity_versions" ADD COLUMN "source_template_version" integer;
--> statement-breakpoint
ALTER TABLE "personal_agent_identity_versions" ADD CONSTRAINT "personal_agent_identity_versions_template_source_pair_check" CHECK (("source_template_id" IS NULL) = ("source_template_version" IS NULL));
--> statement-breakpoint
ALTER TABLE "personal_agent_identity_versions" ADD CONSTRAINT "personal_agent_identity_versions_template_source_fk" FOREIGN KEY ("source_template_id","source_template_version") REFERENCES "public"."personal_agent_role_template_versions"("template_id","version") ON DELETE RESTRICT ON UPDATE RESTRICT;
--> statement-breakpoint
CREATE INDEX "personal_agent_role_template_versions_published_idx" ON "personal_agent_role_template_versions" USING btree ("template_id","version" DESC NULLS LAST);
