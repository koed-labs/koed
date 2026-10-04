CREATE TABLE "personal_studio_removals" (
	"owner_user_id" uuid NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_studio_removals_owner_user_id_target_kind_target_id_pk" PRIMARY KEY("owner_user_id","target_kind","target_id"),
	CONSTRAINT "personal_studio_removals_target_kind_check" CHECK ("personal_studio_removals"."target_kind" in ('project', 'conversation')),
	CONSTRAINT "personal_studio_removals_target_id_check" CHECK (length("personal_studio_removals"."target_id") between 1 and 512)
);
--> statement-breakpoint
ALTER TABLE "personal_studio_removals" ADD CONSTRAINT "personal_studio_removals_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "personal_studio_removals_owner_removed_idx" ON "personal_studio_removals" USING btree ("owner_user_id","created_at" DESC NULLS LAST);