ALTER TABLE "personal_project_default_reconciliation" DROP CONSTRAINT "personal_project_default_reconciliation_owner_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "personal_project_defaults" DROP CONSTRAINT "personal_project_defaults_owner_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "personal_project_default_reconciliation" ADD CONSTRAINT "personal_project_default_reconciliation_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_project_defaults" ADD CONSTRAINT "personal_project_defaults_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;