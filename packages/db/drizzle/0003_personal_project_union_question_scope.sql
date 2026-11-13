ALTER TABLE "memory_questions" DROP CONSTRAINT "memory_questions_search_domain_check";--> statement-breakpoint
-- Application boundaries validate the accepted Project union retained in encrypted retrieval metadata.
ALTER TABLE "memory_questions" ADD CONSTRAINT "memory_questions_search_domain_check" CHECK (("memory_questions"."search_domain" = 'global')
        or ("memory_questions"."search_domain" = 'project' and "memory_questions"."project_id" is not null)
        or ("memory_questions"."search_domain" = 'project' and "memory_questions"."origin" = 'mcp_memory_answer'
          and "memory_questions"."visibility" = 'personal' and "memory_questions"."team_workspace_id" is null
          and "memory_questions"."retrieval" is not null
          and "memory_questions"."retrieval" @> '{"contentEncrypted":true,"encryptedSourceTable":"memory_questions"}'::jsonb)
        or ("memory_questions"."search_domain" = 'session' and "memory_questions"."session_id" is not null));
