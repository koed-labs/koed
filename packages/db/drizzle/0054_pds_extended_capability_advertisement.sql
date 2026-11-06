ALTER TABLE "pds_configuration_capabilities" ADD COLUMN "extended_record" jsonb;
--> statement-breakpoint
-- Pre-release devices may have published the extended format as their only
-- advertisement. Let their next signed refresh supply the two views.
DELETE FROM "pds_configuration_capabilities"
WHERE canonical_advertisement::jsonb->'features' ? 'project_kin_v1';
