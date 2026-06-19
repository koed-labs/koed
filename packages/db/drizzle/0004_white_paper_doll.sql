ALTER TABLE "audit_events" ADD COLUMN "audit_sequence" bigserial NOT NULL;--> statement-breakpoint
CREATE INDEX "audit_events_team_metadata_idx" ON "audit_events" USING btree (("metadata" ->> 'teamId'),"created_at" DESC NULLS LAST,"audit_sequence" DESC NULLS LAST) WHERE "audit_events"."action" like 'team.%' and "audit_events"."metadata" ? 'teamId';
