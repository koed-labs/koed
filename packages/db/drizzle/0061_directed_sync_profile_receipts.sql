ALTER TYPE "public"."sync_package_state" ADD VALUE 'superseded';--> statement-breakpoint
CREATE TABLE "sync_profile_transition_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sync_relationship_id" uuid NOT NULL,
	"protocol_package_id" uuid NOT NULL,
	"source_sequence" bigint NOT NULL,
	"request_digest" text NOT NULL,
	"receipt" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_profile_transition_package_unique" UNIQUE("sync_relationship_id","protocol_package_id"),
	CONSTRAINT "sync_profile_transition_sequence_unique" UNIQUE("sync_relationship_id","source_sequence"),
	CONSTRAINT "sync_profile_transition_sequence_check" CHECK ("sync_profile_transition_receipts"."source_sequence">0),
	CONSTRAINT "sync_profile_transition_digest_check" CHECK ("sync_profile_transition_receipts"."request_digest" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "sync_profile_transition_receipts" ADD CONSTRAINT "sync_profile_transition_receipts_sync_relationship_id_cross_identity_sync_relationships_id_fk" FOREIGN KEY ("sync_relationship_id") REFERENCES "public"."cross_identity_sync_relationships"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION sync_guard_profile_transition_receipt() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Sync profile transition receipts are immutable';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER sync_profile_transition_receipt_guard BEFORE UPDATE ON sync_profile_transition_receipts
FOR EACH ROW EXECUTE FUNCTION sync_guard_profile_transition_receipt();
