import {
  COLLABORATION_CONTRACT_VERSION,
  type CollaborationRendererCommand
} from "@koed/shared";
import { describe, expect, it } from "vitest";

import {
  collaborationCommandRegistry,
  collaborationCommandScope,
  desktopCollaborationOperationFamily,
  personalCollaborationOperationFor,
  teamCollaborationOperationFor,
  teamCollaborationResultMatchesCommand,
  type CollaborationCommandName
} from "./collaboration-command-registry.js";

type ExpectedDescriptor = {
  scope: "personal" | "team" | "dynamic" | "unsupported";
  desktop: "personal_collaboration_read" | "personal_collaboration_write";
  personalOperation?: true;
  teamOperation?: true;
  teamResultMatcher?: true;
};

const read = "personal_collaboration_read" as const;
const write = "personal_collaboration_write" as const;

const expectedRegistry: Record<CollaborationCommandName, ExpectedDescriptor> = {
  "collaboration.load": { scope: "personal", desktop: read },
  "collaboration.select": { scope: "dynamic", desktop: read },
  "collaboration.connect_backend": { scope: "unsupported", desktop: write },
  "collaboration.reconnect_backend": { scope: "unsupported", desktop: write },
  "collaboration.disconnect_backend": { scope: "unsupported", desktop: write },
  "collaboration.request_action_grant": { scope: "team", desktop: write },
  "collaboration.await_action_grant": { scope: "team", desktop: read },
  "collaboration.cancel_action_grant": { scope: "team", desktop: write },
  "collaboration.create_team": { scope: "team", desktop: write },
  "collaboration.join_team": { scope: "team", desktop: write },
  "collaboration.create_workspace": { scope: "team", desktop: write },
  "collaboration.create_notes_to_self": {
    scope: "personal",
    desktop: write,
    personalOperation: true
  },
  "collaboration.create_personal_channel": {
    scope: "personal",
    desktop: write,
    personalOperation: true
  },
  "collaboration.create_workspace_channel": {
    scope: "team",
    desktop: write,
    teamOperation: true,
    teamResultMatcher: true
  },
  "collaboration.start_direct_message": {
    scope: "team",
    desktop: write,
    teamOperation: true,
    teamResultMatcher: true
  },
  "collaboration.start_group_direct_message": {
    scope: "team",
    desktop: write,
    teamOperation: true,
    teamResultMatcher: true
  },
  "collaboration.rename_thread": {
    scope: "dynamic",
    desktop: write,
    personalOperation: true,
    teamOperation: true,
    teamResultMatcher: true
  },
  "collaboration.update_thread_topic": {
    scope: "dynamic",
    desktop: write,
    personalOperation: true,
    teamOperation: true,
    teamResultMatcher: true
  },
  "collaboration.archive_thread": {
    scope: "dynamic",
    desktop: write,
    personalOperation: true,
    teamOperation: true,
    teamResultMatcher: true
  },
  "collaboration.restore_thread": {
    scope: "dynamic",
    desktop: write,
    personalOperation: true,
    teamOperation: true,
    teamResultMatcher: true
  },
  "collaboration.send_message": {
    scope: "dynamic",
    desktop: write,
    personalOperation: true,
    teamOperation: true,
    teamResultMatcher: true
  },
  "collaboration.retry_message": {
    scope: "dynamic",
    desktop: write,
    personalOperation: true,
    teamOperation: true,
    teamResultMatcher: true
  },
  "collaboration.mark_read": {
    scope: "dynamic",
    desktop: write,
    personalOperation: true,
    teamOperation: true,
    teamResultMatcher: true
  },
  "collaboration.load_message_page": {
    scope: "dynamic",
    desktop: read,
    teamOperation: true,
    teamResultMatcher: true
  },
  "collaboration.load_shared_source_page": { scope: "team", desktop: read },
  "collaboration.create_invitation": { scope: "team", desktop: write },
  "collaboration.list_invitations": { scope: "team", desktop: read },
  "collaboration.revoke_invitation": { scope: "team", desktop: write },
  "collaboration.update_member_role": { scope: "team", desktop: write },
  "collaboration.disable_member": { scope: "team", desktop: write },
  "collaboration.leave_team": { scope: "team", desktop: write },
  "collaboration.archive_workspace": { scope: "team", desktop: write },
  "collaboration.restore_workspace": { scope: "team", desktop: write },
  "collaboration.set_workspace_access": { scope: "team", desktop: write },
  "collaboration.list_owned_shared_memory_grants": {
    scope: "team",
    desktop: read
  },
  "collaboration.prepare_shared_memory_source": {
    scope: "team",
    desktop: write
  },
  "collaboration.pause_shared_memory_sync": {
    scope: "team",
    desktop: write
  },
  "collaboration.resume_shared_memory_sync": {
    scope: "team",
    desktop: write
  },
  "collaboration.revoke_shared_memory_sync": {
    scope: "team",
    desktop: write
  },
  "collaboration.preview_shared_memory": { scope: "team", desktop: write },
  "collaboration.load_shared_memory_preview_page": {
    scope: "team",
    desktop: read
  },
  "collaboration.consent_shared_memory": { scope: "team", desktop: write },
  "collaboration.share_memory": { scope: "team", desktop: write },
  "collaboration.revoke_shared_memory": { scope: "team", desktop: write },
  "collaboration.change_shared_memory_representation": {
    scope: "team",
    desktop: write
  },
  "collaboration.subscribe": { scope: "dynamic", desktop: read },
  "collaboration.unsubscribe": { scope: "unsupported", desktop: write },
  "collaboration.acknowledge_delivery": {
    scope: "unsupported",
    desktop: write
  }
};

const requestId = "00000000-0000-4000-8000-000000000001";
const teamId = "00000000-0000-4000-8000-000000000002";
const workspaceId = "00000000-0000-4000-8000-000000000003";
const threadId = "00000000-0000-4000-8000-000000000004";
const messageId = "00000000-0000-4000-8000-000000000005";
const clientMessageId = "00000000-0000-4000-8000-000000000006";

const command = (
  name: CollaborationCommandName,
  input: Record<string, unknown>
): CollaborationRendererCommand =>
  ({
    contractVersion: COLLABORATION_CONTRACT_VERSION,
    requestId,
    command: name,
    input
  }) as CollaborationRendererCommand;

describe("collaboration command registry", () => {
  it("exhaustively describes every renderer command", () => {
    expect(Object.keys(collaborationCommandRegistry).sort()).toEqual(
      Object.keys(expectedRegistry).sort()
    );

    for (const name of Object.keys(
      expectedRegistry
    ) as CollaborationCommandName[]) {
      const descriptor = collaborationCommandRegistry[name];
      const expected = expectedRegistry[name];
      expect(
        typeof descriptor.scope === "function" ? "dynamic" : descriptor.scope,
        `${name} scope`
      ).toBe(expected.scope);
      expect(descriptor.desktopOperationFamily, `${name} Desktop family`).toBe(
        expected.desktop
      );
      expect(
        "personalOperation" in descriptor,
        `${name} Personal operation`
      ).toBe(expected.personalOperation === true);
      expect("teamOperation" in descriptor, `${name} Team operation`).toBe(
        expected.teamOperation === true
      );
      expect(
        "matchesTeamResult" in descriptor,
        `${name} Team result matcher`
      ).toBe(expected.teamResultMatcher === true);
    }
  });

  it("classifies dynamic scopes without allowing cross-scope operations", () => {
    const personalThread = {
      scope: "personal",
      threadId
    };
    const teamThread = { scope: "team", teamId, threadId };

    const personalSend = command("collaboration.send_message", {
      thread: personalThread,
      clientMessageId,
      body: "hello"
    });
    const teamSend = command("collaboration.send_message", {
      thread: teamThread,
      clientMessageId,
      body: "hello"
    });

    expect(collaborationCommandScope(personalSend)).toBe("personal");
    expect(collaborationCommandScope(teamSend)).toBe("team");
    expect(personalCollaborationOperationFor(teamSend)).toBeNull();
    expect(teamCollaborationOperationFor(personalSend)).toBeNull();
    expect(
      collaborationCommandScope(
        command("collaboration.select", {
          selection: { kind: "personal_memory" }
        })
      )
    ).toBe("personal");
    expect(
      collaborationCommandScope(
        command("collaboration.select", {
          selection: { kind: "team_people", teamId }
        })
      )
    ).toBe("team");
    expect(
      collaborationCommandScope(
        command("collaboration.subscribe", {
          scope: { scope: "personal" }
        })
      )
    ).toBe("personal");
    expect(
      collaborationCommandScope(
        command("collaboration.subscribe", {
          scope: { scope: "team", teamId }
        })
      )
    ).toBe("team");
  });

  it("constructs scoped upstream operations and validates bound results", () => {
    const personalMarkRead = command("collaboration.mark_read", {
      thread: { scope: "personal", threadId },
      messageId
    });
    expect(desktopCollaborationOperationFamily(personalMarkRead)).toBe(write);
    expect(personalCollaborationOperationFor(personalMarkRead)).toEqual({
      operationFamily: read,
      method: "PUT",
      path: `/v1/collaboration/personal/threads/${threadId}/read-state`,
      body: { messageId },
      resultKey: "readState"
    });

    const createChannel = command("collaboration.create_workspace_channel", {
      teamId,
      workspaceId,
      name: "Product",
      topic: "Launch"
    });
    expect(teamCollaborationOperationFor(createChannel)).toEqual({
      operationFamily: "team_chat_write",
      method: "POST",
      path: `/v1/collaboration/teams/${teamId}/workspaces/${workspaceId}/channels`,
      body: { name: "Product", topic: "Launch" },
      resultKey: "thread",
      idempotencyKey: requestId
    });
    expect(
      teamCollaborationResultMatchesCommand(createChannel, {
        kind: "workspace_channel",
        teamId,
        workspaceId,
        name: "Product",
        topic: "Launch"
      })
    ).toBe(true);
    expect(
      teamCollaborationResultMatchesCommand(createChannel, {
        kind: "workspace_channel",
        teamId,
        workspaceId: "00000000-0000-4000-8000-000000000099",
        name: "Product",
        topic: "Launch"
      })
    ).toBe(false);
  });
});
