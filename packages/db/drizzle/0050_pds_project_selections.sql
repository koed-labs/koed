CREATE TABLE "pds_project_associations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"association_id" text NOT NULL,
	"selection_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pds_project_association_group_unique" UNIQUE("group_id","association_id"),
	CONSTRAINT "pds_project_selection_group_unique" UNIQUE("group_id","selection_id")
);
--> statement-breakpoint
CREATE TABLE "pds_project_selection_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"association_row_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"revision_id" text NOT NULL,
	"signed_record" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pds_project_selection_revision_group_unique" UNIQUE("group_id","revision_id")
);
--> statement-breakpoint
ALTER TABLE "pds_project_associations" ADD CONSTRAINT "pds_project_associations_group_id_personal_device_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."personal_device_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_project_selection_revisions" ADD CONSTRAINT "pds_project_selection_revisions_association_row_id_pds_project_associations_id_fk" FOREIGN KEY ("association_row_id") REFERENCES "public"."pds_project_associations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_project_selection_revisions" ADD CONSTRAINT "pds_project_selection_revisions_group_id_personal_device_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."personal_device_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pds_project_selection_association_idx" ON "pds_project_selection_revisions" USING btree ("association_row_id");