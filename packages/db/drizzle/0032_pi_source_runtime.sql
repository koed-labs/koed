ALTER TYPE "public"."source_runtime" ADD VALUE IF NOT EXISTS 'pi';
--> statement-breakpoint
INSERT INTO "projection_policy_rules" (
	"source_kind",
	"source_adapter_version",
	"transcript_type",
	"description",
	"project_to_ui",
	"create_message",
	"create_tool_event",
	"create_memory_event",
	"include_in_embedding",
	"include_in_lcm"
) VALUES
	('pi', 'pi-session-v1', 'user_message', 'User-authored Pi session message.', true, true, false, true, true, true),
	('pi', 'pi-session-v1', 'agent_message', 'AI Client-authored Pi session message.', true, true, false, true, true, true),
	('pi', 'pi-session-v1', 'tool_call', 'Pi session tool call.', true, true, true, true, true, true),
	('pi', 'pi-session-v1', 'tool_result', 'Pi session tool result.', true, true, true, true, true, true),
	('pi', 'pi-session-v1', 'bash_execution', 'Pi direct bash execution.', true, true, true, true, true, true),
	('pi', 'pi-session-v1', 'agent_reasoning', 'Pi reasoning, compaction, and branch summaries are retained as raw provenance only.', false, false, false, false, false, false),
	('pi', 'pi-session-v1', 'compaction', 'Pi reasoning, compaction, and branch summaries are retained as raw provenance only.', false, false, false, false, false, false),
	('pi', 'pi-session-v1', 'branch_summary', 'Pi reasoning, compaction, and branch summaries are retained as raw provenance only.', false, false, false, false, false, false),
	('pi', 'pi-session-v1', 'unknown', 'Unsupported Pi session records are retained as raw provenance only.', false, false, false, false, false, false)
ON CONFLICT DO NOTHING;
