CREATE TABLE "collaboration_thread_audiences" (
	"thread_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"member_set_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collaboration_thread_audiences_thread_id_version_pk" PRIMARY KEY("thread_id","version"),
	CONSTRAINT "collaboration_thread_audiences_values_check" CHECK ("collaboration_thread_audiences"."version" > 0 and length("collaboration_thread_audiences"."member_set_hash") = 64)
);
--> statement-breakpoint
CREATE TABLE "collaboration_thread_audience_members" (
	"thread_id" uuid NOT NULL,
	"audience_version" integer NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collaboration_thread_audience_members_thread_id_audience_version_user_id_pk" PRIMARY KEY("thread_id","audience_version","user_id"),
	CONSTRAINT "collaboration_thread_audience_members_version_check" CHECK ("collaboration_thread_audience_members"."audience_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "collaboration_read_states" RENAME TO "collaboration_receipt_states";--> statement-breakpoint
ALTER TABLE "collaboration_messages" DROP CONSTRAINT "collaboration_messages_sequence_check";--> statement-breakpoint
ALTER TABLE "collaboration_receipt_states" DROP CONSTRAINT "collaboration_read_states_cursor_check";--> statement-breakpoint
ALTER TABLE "collaboration_receipt_states" DROP CONSTRAINT "collaboration_read_states_thread_id_collaboration_threads_id_fk";--> statement-breakpoint
ALTER TABLE "collaboration_receipt_states" DROP CONSTRAINT "collaboration_read_states_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "collaboration_receipt_states" DROP CONSTRAINT "collaboration_read_states_same_thread_message_fk";--> statement-breakpoint
DROP INDEX "collaboration_read_states_user_idx";--> statement-breakpoint
ALTER TABLE "collaboration_receipt_states" DROP CONSTRAINT "collaboration_read_states_thread_id_user_id_pk";--> statement-breakpoint
ALTER TABLE "collaboration_receipt_states" ADD CONSTRAINT "collaboration_receipt_states_thread_id_user_id_pk" PRIMARY KEY("thread_id","user_id");--> statement-breakpoint
ALTER TABLE "collaboration_messages" ADD COLUMN "audience_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "collaboration_receipt_states" ADD COLUMN "last_delivered_message_id" uuid;--> statement-breakpoint
ALTER TABLE "collaboration_receipt_states" ADD COLUMN "last_delivered_sequence" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "collaboration_receipt_states" ADD COLUMN "last_delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "collaboration_receipt_states" ADD COLUMN "last_read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "collaboration_threads" ADD COLUMN "audience_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
INSERT INTO collaboration_thread_audiences (
	thread_id,
	version,
	member_set_hash
)
SELECT
	thread.id,
	1,
	encode(
		digest(
			E'koed:collaboration:audience-members:v1\n[]',
			'sha256'
		),
		'hex'
	)
FROM collaboration_threads thread;--> statement-breakpoint
UPDATE collaboration_receipt_states
SET
	last_delivered_message_id = last_read_message_id,
	last_delivered_sequence = last_read_sequence,
	last_delivered_at = CASE
		WHEN last_read_message_id IS NULL THEN NULL
		ELSE updated_at
	END,
	last_read_at = CASE
		WHEN last_read_message_id IS NULL THEN NULL
		ELSE updated_at
	END;--> statement-breakpoint
ALTER TABLE "collaboration_outbox" ALTER COLUMN "family" SET DATA TYPE text;--> statement-breakpoint
UPDATE collaboration_outbox
SET family = 'receipt_state_updated'
WHERE family = 'read_state_updated';--> statement-breakpoint
DROP TYPE "public"."collaboration_event_family";--> statement-breakpoint
CREATE TYPE "public"."collaboration_event_family" AS ENUM('team_lifecycle', 'team_membership_access', 'workspace_lifecycle_access', 'thread_lifecycle', 'message_created', 'receipt_state_updated', 'share_grant_lifecycle', 'representation_changed', 'memory_event_available', 'lcm_leaf_available', 'lcm_rollup_available', 'shared_session_discussion_activity', 'personal_memory_changed', 'managed_conversation_changed', 'access_revoked');--> statement-breakpoint
ALTER TABLE "collaboration_outbox" ALTER COLUMN "family" SET DATA TYPE "public"."collaboration_event_family" USING "family"::"public"."collaboration_event_family";--> statement-breakpoint
ALTER TABLE "collaboration_messages" ALTER COLUMN "audience_version" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "collaboration_thread_audience_members" ADD CONSTRAINT "collaboration_thread_audience_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_thread_audience_members" ADD CONSTRAINT "collaboration_thread_audience_members_audience_fk" FOREIGN KEY ("thread_id","audience_version") REFERENCES "public"."collaboration_thread_audiences"("thread_id","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_thread_audiences" ADD CONSTRAINT "collaboration_thread_audiences_thread_id_collaboration_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."collaboration_threads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collaboration_thread_audience_members_user_idx" ON "collaboration_thread_audience_members" USING btree ("user_id","thread_id","audience_version");--> statement-breakpoint
CREATE INDEX "collaboration_thread_audiences_created_idx" ON "collaboration_thread_audiences" USING btree ("thread_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "collaboration_messages" ADD CONSTRAINT "collaboration_messages_audience_fk" FOREIGN KEY ("thread_id","audience_version") REFERENCES "public"."collaboration_thread_audiences"("thread_id","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_receipt_states" ADD CONSTRAINT "collaboration_receipt_states_thread_id_collaboration_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."collaboration_threads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_receipt_states" ADD CONSTRAINT "collaboration_receipt_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_receipt_states" ADD CONSTRAINT "collaboration_receipt_states_delivered_message_fk" FOREIGN KEY ("thread_id","last_delivered_message_id","last_delivered_sequence") REFERENCES "public"."collaboration_messages"("thread_id","id","thread_sequence") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_receipt_states" ADD CONSTRAINT "collaboration_receipt_states_read_message_fk" FOREIGN KEY ("thread_id","last_read_message_id","last_read_sequence") REFERENCES "public"."collaboration_messages"("thread_id","id","thread_sequence") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collaboration_receipt_states_user_idx" ON "collaboration_receipt_states" USING btree ("user_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "collaboration_messages" ADD CONSTRAINT "collaboration_messages_sequence_check" CHECK ("collaboration_messages"."thread_sequence" > 0 and "collaboration_messages"."audience_version" > 0);--> statement-breakpoint
ALTER TABLE "collaboration_receipt_states" ADD CONSTRAINT "collaboration_receipt_states_cursor_check" CHECK ("collaboration_receipt_states"."last_delivered_sequence" >= 0
        and "collaboration_receipt_states"."last_read_sequence" >= 0
        and "collaboration_receipt_states"."last_delivered_sequence" >= "collaboration_receipt_states"."last_read_sequence"
        and "collaboration_receipt_states"."version" > 0
        and (("collaboration_receipt_states"."last_delivered_message_id" is null and "collaboration_receipt_states"."last_delivered_sequence" = 0 and "collaboration_receipt_states"."last_delivered_at" is null)
          or ("collaboration_receipt_states"."last_delivered_message_id" is not null and "collaboration_receipt_states"."last_delivered_sequence" > 0 and "collaboration_receipt_states"."last_delivered_at" is not null))
        and (("collaboration_receipt_states"."last_read_message_id" is null and "collaboration_receipt_states"."last_read_sequence" = 0 and "collaboration_receipt_states"."last_read_at" is null)
          or ("collaboration_receipt_states"."last_read_message_id" is not null and "collaboration_receipt_states"."last_read_sequence" > 0 and "collaboration_receipt_states"."last_read_at" is not null)));--> statement-breakpoint
ALTER TABLE "collaboration_threads" ADD CONSTRAINT "collaboration_threads_audience_version_check" CHECK ("collaboration_threads"."audience_version" > 0);
