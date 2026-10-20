CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"role" text,
	"look" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ai_client_instance_id" text NOT NULL,
	"default_permission_mode" text DEFAULT 'supervised' NOT NULL,
	"default_model" text,
	"is_chief_of_staff" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_name_check" CHECK (length(trim("agents"."name")) between 1 and 120),
	CONSTRAINT "agents_role_check" CHECK ("agents"."role" is null or length(trim("agents"."role")) between 1 and 240),
	CONSTRAINT "agents_look_check" CHECK (jsonb_typeof("agents"."look") = 'object' and octet_length("agents"."look"::text) <= 4096),
	CONSTRAINT "agents_permission_mode_check" CHECK ("agents"."default_permission_mode" in ('supervised', 'auto_edit', 'auto', 'full_access')),
	CONSTRAINT "agents_model_check" CHECK ("agents"."default_model" is null or length(trim("agents"."default_model")) between 1 and 512)
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_owner_instance_fk" FOREIGN KEY ("owner_user_id","ai_client_instance_id") REFERENCES "public"."ai_client_instances"("owner_user_id","instance_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_one_chief_per_owner_idx" ON "agents" USING btree ("owner_user_id") WHERE "agents"."is_chief_of_staff" = true;--> statement-breakpoint
CREATE INDEX "agents_owner_created_idx" ON "agents" USING btree ("owner_user_id","created_at");