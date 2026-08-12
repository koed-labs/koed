-- Shared Memory previews may bind an inactive source-owner policy proposal.
-- The final reviewed bundle validates its artifact hashes before activation.
ALTER TABLE "shared_source_artifacts" DROP CONSTRAINT "shared_source_artifacts_owner_policy_fk";
