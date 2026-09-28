ALTER TABLE "ai_client_capability_snapshots" DROP CONSTRAINT "ai_client_capability_snapshots_instance_fk";
--> statement-breakpoint
DROP INDEX "ai_client_capability_snapshots_current_idx";--> statement-breakpoint
ALTER TABLE "ai_client_capability_snapshots" ADD COLUMN "source_device_credential_id" uuid DEFAULT '00000000-0000-0000-0000-000000000000' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_client_instances" ADD COLUMN "source_device_credential_id" uuid DEFAULT '00000000-0000-0000-0000-000000000000' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_client_instances" ADD COLUMN "source_device_label" text;--> statement-breakpoint
ALTER TABLE "ai_client_instances" DROP CONSTRAINT "ai_client_instances_owner_user_id_instance_id_pk";--> statement-breakpoint
ALTER TABLE "ai_client_instances" ADD CONSTRAINT "ai_client_instances_owner_user_id_instance_id_source_device_credential_id_pk" PRIMARY KEY("owner_user_id","instance_id","source_device_credential_id");--> statement-breakpoint
ALTER TABLE "ai_client_capability_snapshots" ADD CONSTRAINT "ai_client_capability_snapshots_instance_fk" FOREIGN KEY ("owner_user_id","instance_id","source_device_credential_id") REFERENCES "public"."ai_client_instances"("owner_user_id","instance_id","source_device_credential_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_client_capability_snapshots_current_idx" ON "ai_client_capability_snapshots" USING btree ("owner_user_id","instance_id","source_device_credential_id","observed_at" DESC NULLS LAST);--> statement-breakpoint
