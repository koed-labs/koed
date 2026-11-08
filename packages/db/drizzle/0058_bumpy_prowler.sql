CREATE TABLE "peer_online_deletion_outbox" (
	"group_id" text NOT NULL,
	"session_key" text NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"local_session_id" uuid NOT NULL,
	"prepared_deletion" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "peer_online_deletion_outbox_group_id_session_key_pk" PRIMARY KEY("group_id","session_key"),
	CONSTRAINT "peer_online_deletion_outbox_owner_user_id_local_session_id_unique" UNIQUE("owner_user_id","local_session_id")
);
--> statement-breakpoint
ALTER TABLE "peer_online_deletion_outbox" ADD CONSTRAINT "peer_online_deletion_outbox_group_id_session_key_peer_online_sessions_group_id_session_key_fk" FOREIGN KEY ("group_id","session_key") REFERENCES "public"."peer_online_sessions"("group_id","session_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "peer_online_deletion_outbox" ADD CONSTRAINT "peer_online_deletion_outbox_local_session_id_owner_user_id_sessions_id_owner_user_id_fk" FOREIGN KEY ("local_session_id","owner_user_id") REFERENCES "public"."sessions"("id","owner_user_id") ON DELETE no action ON UPDATE no action;