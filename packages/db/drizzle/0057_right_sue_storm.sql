CREATE TABLE "peer_online_checkpoints" (
	"group_id" text NOT NULL,
	"session_key" text NOT NULL,
	"sequence" text NOT NULL,
	"hash" text NOT NULL,
	"envelope" text NOT NULL,
	"payload" text NOT NULL,
	CONSTRAINT "peer_online_checkpoints_group_id_session_key_sequence_pk" PRIMARY KEY("group_id","session_key","sequence")
);
--> statement-breakpoint
CREATE TABLE "peer_online_sessions" (
	"group_id" text NOT NULL,
	"session_key" text NOT NULL,
	"binding_hash" text NOT NULL,
	"binding" text NOT NULL,
	"deletion_hash" text,
	"deletion" text,
	"checkpoint_sequence" text,
	"checkpoint_hash" text,
	CONSTRAINT "peer_online_sessions_group_id_session_key_pk" PRIMARY KEY("group_id","session_key")
);
--> statement-breakpoint
ALTER TABLE "peer_online_checkpoints" ADD CONSTRAINT "peer_online_checkpoints_group_id_session_key_peer_online_sessions_group_id_session_key_fk" FOREIGN KEY ("group_id","session_key") REFERENCES "public"."peer_online_sessions"("group_id","session_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "peer_online_sessions" ADD CONSTRAINT "peer_online_sessions_group_id_peer_online_membership_groups_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."peer_online_membership_groups"("group_id") ON DELETE no action ON UPDATE no action;