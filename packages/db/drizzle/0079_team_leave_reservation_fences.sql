-- A relevant write invalidates an inactive-copy departure reservation in the
-- same transaction. The write itself proceeds, so revocation and Team
-- governance are never blocked by an offline owner device. Finalization sees
-- a canceled operation and requires a fresh exact approval.
CREATE FUNCTION koed_cancel_prepared_team_leave(
  target_team uuid, target_project uuid, reason text
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE team_leave_operations operation
     SET state='canceled', canceled_at=now(), canceled_reason=reason,
         updated_at=now()
   WHERE operation.team_id=target_team AND operation.state='prepared'
     AND (target_project IS NULL OR operation.owned_projects @>
       jsonb_build_array(jsonb_build_object('id',target_project)));
END $$;
--> statement-breakpoint

-- Child writers lock the Project before examining the reservation. Prepare
-- locks the same row before recording the reviewed Project set, so copy-back
-- cannot be reported complete across an unnoticed source change.
CREATE FUNCTION koed_team_leave_project_write_fence() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  candidate jsonb;
  project_key uuid;
  project_team uuid;
BEGIN
  FOR candidate IN SELECT value FROM jsonb_array_elements(
    CASE WHEN TG_OP='INSERT' THEN jsonb_build_array(to_jsonb(NEW))
         WHEN TG_OP='DELETE' THEN jsonb_build_array(to_jsonb(OLD))
         ELSE jsonb_build_array(to_jsonb(OLD),to_jsonb(NEW)) END
  ) LOOP
    IF TG_ARGV[0]='workspace_id' THEN
      FOR project_key, project_team IN
        SELECT project.id, project.team_id FROM workspace_projects project
         WHERE project.workspace_id=(candidate ->> TG_ARGV[1])::uuid
         FOR SHARE
      LOOP
        PERFORM koed_cancel_prepared_team_leave(
          project_team, project_key, 'workspace_changed');
      END LOOP;
      CONTINUE;
    ELSE
      project_key := (candidate ->> TG_ARGV[0])::uuid;
    END IF;
    IF project_key IS NULL THEN CONTINUE; END IF;
    SELECT project.team_id INTO project_team FROM workspace_projects project
     WHERE project.id=project_key FOR SHARE;
    IF project_team IS NOT NULL THEN
      PERFORM koed_cancel_prepared_team_leave(
        project_team, project_key, 'project_changed');
    END IF;
  END LOOP;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
--> statement-breakpoint

CREATE FUNCTION koed_team_leave_team_write_fence() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  team_key uuid;
BEGIN
  FOR team_key IN SELECT DISTINCT value::uuid FROM jsonb_array_elements_text(
    CASE WHEN TG_OP='INSERT' THEN jsonb_build_array(to_jsonb(NEW) ->> TG_ARGV[0])
         WHEN TG_OP='DELETE' THEN jsonb_build_array(to_jsonb(OLD) ->> TG_ARGV[0])
         ELSE jsonb_build_array(to_jsonb(OLD) ->> TG_ARGV[0],
                               to_jsonb(NEW) ->> TG_ARGV[0]) END
  ) WHERE value IS NOT NULL LOOP
    IF TG_TABLE_NAME <> 'teams' THEN
      PERFORM 1 FROM teams WHERE id=team_key FOR SHARE;
    END IF;
    PERFORM koed_cancel_prepared_team_leave(
      team_key, NULL, 'team_authority_changed');
  END LOOP;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
--> statement-breakpoint

CREATE FUNCTION koed_team_leave_owned_set_fence() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  candidate jsonb;
  team_key uuid;
  owner_key uuid;
BEGIN
  FOR candidate IN SELECT value FROM jsonb_array_elements(
    CASE WHEN TG_OP='INSERT' THEN jsonb_build_array(to_jsonb(NEW))
         WHEN TG_OP='DELETE' THEN jsonb_build_array(to_jsonb(OLD))
         ELSE jsonb_build_array(to_jsonb(OLD),to_jsonb(NEW)) END
  ) LOOP
    team_key := (candidate ->> 'team_id')::uuid;
    owner_key := (candidate ->> 'owner_team_member_id')::uuid;
    PERFORM 1 FROM teams WHERE id=team_key FOR SHARE;
    UPDATE team_leave_operations operation
       SET state='canceled', canceled_at=now(),
           canceled_reason='owned_project_set_changed', updated_at=now()
     WHERE operation.team_id=team_key AND operation.membership_id=owner_key
       AND operation.state='prepared';
  END LOOP;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
--> statement-breakpoint

CREATE TRIGGER team_leave_teams_fence BEFORE UPDATE OR DELETE ON teams
FOR EACH ROW EXECUTE FUNCTION koed_team_leave_team_write_fence('id');
--> statement-breakpoint
CREATE TRIGGER team_leave_memberships_fence BEFORE INSERT OR UPDATE OR DELETE ON team_memberships
FOR EACH ROW EXECUTE FUNCTION koed_team_leave_team_write_fence('team_id');
--> statement-breakpoint
CREATE TRIGGER team_leave_workspaces_fence BEFORE UPDATE OR DELETE ON team_workspaces
FOR EACH ROW EXECUTE FUNCTION koed_team_leave_project_write_fence('workspace_id','id');
--> statement-breakpoint
CREATE TRIGGER team_leave_owned_project_set_fence BEFORE INSERT OR UPDATE OR DELETE ON workspace_projects
FOR EACH ROW EXECUTE FUNCTION koed_team_leave_owned_set_fence();
--> statement-breakpoint
CREATE TRIGGER team_leave_projects_fence BEFORE UPDATE OR DELETE ON workspace_projects
FOR EACH ROW EXECUTE FUNCTION koed_team_leave_project_write_fence('id');
--> statement-breakpoint
CREATE TRIGGER team_leave_project_members_fence BEFORE INSERT OR UPDATE OR DELETE ON workspace_project_members
FOR EACH ROW EXECUTE FUNCTION koed_team_leave_project_write_fence('workspace_project_id');
--> statement-breakpoint
CREATE TRIGGER team_leave_work_items_fence BEFORE INSERT OR UPDATE OR DELETE ON workspace_project_work_items
FOR EACH ROW EXECUTE FUNCTION koed_team_leave_project_write_fence('workspace_project_id');
--> statement-breakpoint
CREATE TRIGGER team_leave_project_sources_fence BEFORE INSERT OR UPDATE OR DELETE ON workspace_project_sources
FOR EACH ROW EXECUTE FUNCTION koed_team_leave_project_write_fence('workspace_project_id');
--> statement-breakpoint
CREATE TRIGGER team_leave_project_decks_fence BEFORE INSERT OR UPDATE OR DELETE ON workspace_project_decks
FOR EACH ROW EXECUTE FUNCTION koed_team_leave_project_write_fence('workspace_project_id');
--> statement-breakpoint
CREATE TRIGGER team_leave_project_deck_cards_fence BEFORE INSERT OR UPDATE OR DELETE ON workspace_project_deck_cards
FOR EACH ROW EXECUTE FUNCTION koed_team_leave_project_write_fence('workspace_project_id');
--> statement-breakpoint
CREATE TRIGGER team_leave_project_policy_fence BEFORE INSERT OR UPDATE OR DELETE ON workspace_project_share_policies
FOR EACH ROW EXECUTE FUNCTION koed_team_leave_project_write_fence('workspace_project_id');
--> statement-breakpoint
CREATE TRIGGER team_leave_project_bindings_fence BEFORE INSERT OR UPDATE OR DELETE ON workspace_project_share_grant_bindings
FOR EACH ROW EXECUTE FUNCTION koed_team_leave_project_write_fence('workspace_project_id');
--> statement-breakpoint
CREATE TRIGGER team_leave_project_invitations_fence BEFORE INSERT OR UPDATE OR DELETE ON team_invites
FOR EACH ROW EXECUTE FUNCTION koed_team_leave_project_write_fence('workspace_project_id');
--> statement-breakpoint
CREATE TRIGGER team_leave_project_threads_fence BEFORE INSERT OR UPDATE OR DELETE ON collaboration_threads
FOR EACH ROW EXECUTE FUNCTION koed_team_leave_project_write_fence('workspace_project_id');
--> statement-breakpoint
CREATE TRIGGER team_leave_project_workspace_access_fence BEFORE INSERT OR UPDATE OR DELETE ON team_workspace_access_grants
FOR EACH ROW EXECUTE FUNCTION koed_team_leave_project_write_fence('workspace_id','team_workspace_id');
