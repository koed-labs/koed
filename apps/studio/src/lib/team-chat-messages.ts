import type { CollaborationMessage } from "@koed/shared/collaboration";
import type { SharedChatMessage } from "./shared-chat-model";

export type TeamChatMessage = SharedChatMessage &
  Readonly<{ source: CollaborationMessage }>;

export function toTeamChatMessages(
  messages: readonly CollaborationMessage[],
  viewerId: string
): TeamChatMessage[] {
  return messages.map((message) => {
    const authoredByViewer = message.sender.id === viewerId;
    return {
      id: message.id,
      role: authoredByViewer ? "user" : "assistant",
      content: message.body,
      authoredByViewer,
      author: { name: message.sender.displayName || "Team member" },
      source: message
    };
  });
}
