ALTER TYPE "public"."collaboration_thread_kind" ADD VALUE 'team_channel' BEFORE 'workspace_channel';--> statement-breakpoint
ALTER TYPE "public"."collaboration_thread_kind" ADD VALUE 'team_project_channel' BEFORE 'workspace_channel';
