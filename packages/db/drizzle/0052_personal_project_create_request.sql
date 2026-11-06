ALTER TABLE "personal_named_projects" ADD COLUMN "create_request_id" uuid;--> statement-breakpoint
ALTER TABLE "personal_named_projects" ADD COLUMN "create_request_name" text;--> statement-breakpoint
ALTER TABLE "personal_named_projects" ADD CONSTRAINT "personal_named_projects_create_request_pair_check" CHECK (("create_request_id" IS NULL) = ("create_request_name" IS NULL));--> statement-breakpoint
CREATE UNIQUE INDEX "personal_named_projects_owner_create_request_uidx" ON "personal_named_projects" USING btree ("owner_user_id","create_request_id") WHERE "create_request_id" IS NOT NULL;
