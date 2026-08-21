ALTER TABLE "managed_conversation_executions" ADD COLUMN "ai_client_instance_id" text;--> statement-breakpoint
UPDATE "managed_conversation_executions"
   SET "ai_client_instance_id" = CASE
     WHEN char_length("provider" || '.default') <= 128
       AND "provider" || '.default' ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){0,7}$'
       THEN "provider" || '.default'
     WHEN char_length("provider") <= 128
       AND "provider" ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){0,7}$'
       THEN "provider"
     ELSE 'legacy.' || md5("provider")
   END
 WHERE "ai_client_instance_id" IS NULL;--> statement-breakpoint
ALTER TABLE "managed_conversation_executions" ALTER COLUMN "ai_client_instance_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_conversation_executions" ADD CONSTRAINT "managed_conversation_executions_ai_client_instance_check" CHECK (char_length("managed_conversation_executions"."ai_client_instance_id") <= 128 AND "managed_conversation_executions"."ai_client_instance_id" ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){0,7}$');