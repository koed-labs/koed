CREATE TABLE "peer_online_admission_attempts" (
	"group_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"expected_head" text NOT NULL,
	"approver_device_id" text NOT NULL,
	"target_json" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"transcript_hash" text,
	"outcome_hash" text,
	"outcome_json" text,
	CONSTRAINT "peer_online_admission_attempts_group_id_attempt_id_pk" PRIMARY KEY("group_id","attempt_id")
);
--> statement-breakpoint
ALTER TABLE "peer_online_admission_attempts" ADD CONSTRAINT "peer_online_admission_attempts_group_id_peer_online_membership_groups_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."peer_online_membership_groups"("group_id") ON DELETE no action ON UPDATE no action;