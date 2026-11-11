CREATE TABLE "memory_node_context_events" (
	"memory_node_id" uuid PRIMARY KEY NOT NULL,
	"memory_event_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_node_context_events" ADD CONSTRAINT "memory_node_context_events_memory_node_id_memory_nodes_id_fk" FOREIGN KEY ("memory_node_id") REFERENCES "public"."memory_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_node_context_events" ADD CONSTRAINT "memory_node_context_events_memory_event_id_memory_events_id_fk" FOREIGN KEY ("memory_event_id") REFERENCES "public"."memory_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_node_context_events_event_idx" ON "memory_node_context_events" USING btree ("memory_event_id");
