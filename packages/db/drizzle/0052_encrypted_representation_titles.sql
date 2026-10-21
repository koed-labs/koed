-- Titles are encrypted companions bound to representation source revision hashes.
-- Remove the plaintext metadata introduced in the preceding local alpha slice.
UPDATE team_memory_representations SET display_title=NULL
 WHERE display_title IS NOT NULL AND display_title<>'[koed encrypted Shared Memory title]';
--> statement-breakpoint
ALTER TABLE "team_memory_representations" ADD CONSTRAINT "team_memory_representations_title_marker_check" CHECK ("team_memory_representations"."display_title" is null or "team_memory_representations"."display_title"='[koed encrypted Shared Memory title]');