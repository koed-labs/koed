CREATE TABLE "peer_online_membership_evidence" (
	"group_id" text NOT NULL,
	"position" integer NOT NULL,
	"hash" text NOT NULL,
	"json" text NOT NULL,
	CONSTRAINT "peer_online_membership_evidence_group_id_position_pk" PRIMARY KEY("group_id","position"),
	CONSTRAINT "peer_online_membership_evidence_group_id_hash_unique" UNIQUE("group_id","hash")
);
--> statement-breakpoint
CREATE TABLE "peer_online_membership_groups" (
	"group_id" text PRIMARY KEY NOT NULL,
	"genesis_hash" text NOT NULL,
	"record_count" integer NOT NULL,
	"conflict" boolean NOT NULL,
	"incomplete" boolean NOT NULL,
	"limit_evidence" text
);
--> statement-breakpoint
ALTER TABLE "peer_online_membership_evidence" ADD CONSTRAINT "peer_online_membership_evidence_group_id_peer_online_membership_groups_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."peer_online_membership_groups"("group_id") ON DELETE no action ON UPDATE no action;