-- Repair databases that recorded the earlier development version of 0037.
ALTER TABLE "managed_conversation_runtime_bindings"
  ADD COLUMN IF NOT EXISTS "start_authority_acknowledged_at" timestamp with time zone;
