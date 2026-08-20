ALTER TABLE "pending_share_operations" DROP CONSTRAINT "pending_share_operations_source_session_id_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "pending_share_operations" DROP CONSTRAINT "pending_share_operations_source_memory_event_id_memory_events_id_fk";
--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" DROP CONSTRAINT "shared_memory_candidate_previews_source_session_id_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" DROP CONSTRAINT "shared_memory_candidate_previews_source_memory_event_id_memory_events_id_fk";
--> statement-breakpoint
ALTER TABLE "shared_source_artifacts" DROP CONSTRAINT "shared_source_artifacts_source_session_id_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "shared_source_artifacts" DROP CONSTRAINT "shared_source_artifacts_source_memory_event_id_memory_events_id_fk";
--> statement-breakpoint
ALTER TABLE "shared_source_previews" DROP CONSTRAINT "shared_source_previews_source_session_id_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "shared_source_previews" DROP CONSTRAINT "shared_source_previews_source_memory_event_id_memory_events_id_fk";
--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" DROP CONSTRAINT "source_owner_representation_consents_source_session_id_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" DROP CONSTRAINT "source_owner_representation_consents_source_memory_event_id_memory_events_id_fk";
--> statement-breakpoint
ALTER TABLE "team_memory_representations" DROP CONSTRAINT "team_memory_representations_source_session_id_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "team_memory_representations" DROP CONSTRAINT "team_memory_representations_source_memory_event_id_memory_events_id_fk";
--> statement-breakpoint
ALTER TABLE "team_session_share_grants" DROP CONSTRAINT "team_session_share_grants_source_memory_event_id_memory_events_id_fk";
