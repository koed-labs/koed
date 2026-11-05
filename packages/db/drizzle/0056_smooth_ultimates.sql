CREATE TABLE "peer_online_group_owners" (
	"group_id" text PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "peer_online_group_owners" ADD CONSTRAINT "peer_online_group_owners_group_id_peer_online_membership_groups_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."peer_online_membership_groups"("group_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "peer_online_group_owners" ADD CONSTRAINT "peer_online_group_owners_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE FUNCTION peer_online_group_owner_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'peer online group owner binding is immutable';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER peer_online_group_owner_immutable BEFORE UPDATE OR DELETE ON peer_online_group_owners FOR EACH ROW EXECUTE FUNCTION peer_online_group_owner_immutable();
