ALTER TABLE "local_edge_collaboration_subscriptions" DROP CONSTRAINT "local_edge_collaboration_subscriptions_values_check";--> statement-breakpoint
DROP INDEX "local_edge_collaboration_subscriptions_personal_binding_unique";--> statement-breakpoint
DROP INDEX "local_edge_collaboration_subscriptions_team_binding_unique";--> statement-breakpoint
ALTER TABLE "collaboration_messages" ADD COLUMN "reply_to_message_id" uuid;--> statement-breakpoint
ALTER TABLE "local_edge_collaboration_subscriptions" ADD COLUMN "message_contract_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "collaboration_messages" ADD CONSTRAINT "collaboration_messages_reply_same_thread_fk" FOREIGN KEY ("thread_id","reply_to_message_id") REFERENCES "public"."collaboration_messages"("thread_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "local_edge_collaboration_subscriptions_personal_binding_unique" ON "local_edge_collaboration_subscriptions" USING btree ("upstream_backend_id","credential_binding_hash","protocol_version","message_contract_version") WHERE "local_edge_collaboration_subscriptions"."scope" = 'personal' and "local_edge_collaboration_subscriptions"."team_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "local_edge_collaboration_subscriptions_team_binding_unique" ON "local_edge_collaboration_subscriptions" USING btree ("upstream_backend_id","credential_binding_hash","team_id","protocol_version","message_contract_version") WHERE "local_edge_collaboration_subscriptions"."scope" = 'team' and "local_edge_collaboration_subscriptions"."team_id" is not null;--> statement-breakpoint
ALTER TABLE "local_edge_collaboration_subscriptions" ADD CONSTRAINT "local_edge_collaboration_subscriptions_values_check" CHECK (length(trim("local_edge_collaboration_subscriptions"."upstream_backend_id")) > 0
        and (("local_edge_collaboration_subscriptions"."scope" = 'personal' and "local_edge_collaboration_subscriptions"."team_id" is null)
          or ("local_edge_collaboration_subscriptions"."scope" = 'team' and "local_edge_collaboration_subscriptions"."team_id" is not null))
        and length("local_edge_collaboration_subscriptions"."credential_binding_hash") = 64
        and "local_edge_collaboration_subscriptions"."protocol_version" > 0
        and "local_edge_collaboration_subscriptions"."message_contract_version" in (1, 2)
        and ("local_edge_collaboration_subscriptions"."scope" = 'team' or "local_edge_collaboration_subscriptions"."message_contract_version" = 1)
        and length("local_edge_collaboration_subscriptions"."remote_cursor") between 16 and 4096
        and "local_edge_collaboration_subscriptions"."version" > 0
        and "local_edge_collaboration_subscriptions"."expires_at" > "local_edge_collaboration_subscriptions"."created_at");