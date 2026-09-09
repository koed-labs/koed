-- Repair databases that applied 0037 before its final acknowledgement column
-- was added. Keep existing acknowledgement values on current databases.
ALTER TABLE "managed_conversation_runtime_bindings"
  ADD COLUMN IF NOT EXISTS "start_authority_acknowledged_at" timestamp with time zone;
