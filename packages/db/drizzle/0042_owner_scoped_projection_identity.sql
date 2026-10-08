DROP INDEX "memory_events_idempotency_key_unique";--> statement-breakpoint
DROP INDEX "memory_events_source_hash_unique";--> statement-breakpoint
DROP INDEX "messages_idempotency_key_unique";--> statement-breakpoint
DROP INDEX "messages_source_hash_unique";--> statement-breakpoint
DROP INDEX "tool_events_idempotency_key_unique";--> statement-breakpoint
DROP INDEX "tool_events_source_hash_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "memory_events_idempotency_key_unique" ON "memory_events" USING btree ("owner_user_id","visibility","idempotency_key") WHERE "memory_events"."idempotency_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_events_source_hash_unique" ON "memory_events" USING btree ("owner_user_id","visibility","source_hash") WHERE "memory_events"."source_hash" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_idempotency_key_unique" ON "messages" USING btree ("owner_user_id","visibility","idempotency_key") WHERE "messages"."idempotency_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_source_hash_unique" ON "messages" USING btree ("owner_user_id","visibility","source_hash") WHERE "messages"."source_hash" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "tool_events_idempotency_key_unique" ON "tool_events" USING btree ("owner_user_id","visibility","idempotency_key") WHERE "tool_events"."idempotency_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "tool_events_source_hash_unique" ON "tool_events" USING btree ("owner_user_id","visibility","source_hash") WHERE "tool_events"."source_hash" is not null;