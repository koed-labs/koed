import type { CollaborationMessage, CollaborationThread } from "@koed/shared/collaboration";

export type DirectMessageThread = Extract<CollaborationThread, { kind: "dm" | "group_dm" }>;

export const directMessageTitle = (thread: DirectMessageThread, principalUserId: string): string => {
  const participants = thread.participants.filter((person) => person.id !== principalUserId);
  return participants.map((person) => person.displayName).join(", ") || "Direct message";
};

export function TeamDirectMessageBubble({ message, principalUserId }: { message: CollaborationMessage; principalUserId: string }) {
  const name = message.sender.displayName ?? "Team member";
  const isYou = message.sender.id === principalUserId;
  return <div className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${isYou ? "rounded-tr-sm bg-surface-hover text-foreground" : "rounded-tl-sm bg-surface text-foreground-secondary"}`}>
    <p className="mb-1 text-[11px] text-subtle">{name}</p>
    <p className="whitespace-pre-wrap break-words">{message.body}</p>
    {message.delivery === "failed" && <p className="mt-1 text-xs text-warning">Not sent</p>}
  </div>;
}
