CREATE TABLE "pds_project_association_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"association_row_id" uuid NOT NULL,
	"originating_device_id" text NOT NULL,
	"checkout_id" text NOT NULL,
	"local_project_id" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pds_project_association_checkout_unique" UNIQUE("owner_user_id","originating_device_id","checkout_id")
);
--> statement-breakpoint
ALTER TABLE "pds_project_association_acceptances" ADD CONSTRAINT "pds_project_association_acceptances_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_project_association_acceptances" ADD CONSTRAINT "pds_project_association_acceptances_association_row_id_pds_project_associations_id_fk" FOREIGN KEY ("association_row_id") REFERENCES "public"."pds_project_associations"("id") ON DELETE cascade ON UPDATE no action;
