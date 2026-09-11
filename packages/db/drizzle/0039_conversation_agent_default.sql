ALTER TABLE "local_memory_agent_settings" DROP CONSTRAINT "local_memory_agent_settings_flow_key_check";
--> statement-breakpoint
ALTER TABLE "local_memory_agent_settings" ADD CONSTRAINT "local_memory_agent_settings_flow_key_check" CHECK ("flow_key" in ('mcp_memory_answer', 'manual_memory_answer', 'lcm_summary', 'curated_memory_review', 'session_title', 'conversations'));
