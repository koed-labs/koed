"use client";

import { useEffect, useState, type ReactNode } from "react";
import { FolderGit2, Hash, X } from "lucide-react";
import { slugifyChannelName } from "@/lib/collab";

// The front door for both halves of "create more channels": a plain chat
// channel (just a name, no project) or a project channel (which is really
// "create a project" - a project's channel is born together with it, per
// bootstrapProjectCollab in workspace.ts, so there's nothing extra to ask
// here). Picking "Project channel" hands off to the existing
// CreateProjectModal immediately rather than duplicating its form; picking
// "Chat channel" stays right here since a name is all it needs.
export function CreateChannelModal({
  teamName,
  existingNames,
  onClose,
  onCreateChat,
  onChooseProject,
  projectDisabledReason,
}: {
  teamName: string;
  // Already-taken channel names in this team, lowercased - checked against
  // the slugified draft so "Design", "design", and "design " all collide.
  existingNames: string[];
  onClose: () => void;
  onCreateChat: (name: string) => void;
  onChooseProject?: () => void;
  projectDisabledReason?: string;
}) {
  const [channelType, setChannelType] = useState<"chat" | "project" | null>(null);
  const [name, setName] = useState("");

  const slug = slugifyChannelName(name);
  const isDuplicate = slug.length > 0 && existingNames.includes(slug);
  const canCreate = slug.length > 0 && !isDuplicate;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const submitChat = () => {
    if (!canCreate) return;
    onCreateChat(slug);
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm no-drag"
      onClick={onClose}
    >
      <div
        className="w-[480px] max-w-[calc(100vw-2rem)] rounded-2xl border border-border bg-surface shadow-2xl overflow-hidden"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4">
          <h2 className="text-base font-semibold text-foreground">New channel</h2>
          <button
            type="button"
            className="rounded-md p-1 text-subtle hover:bg-surface-hover hover:text-foreground-secondary transition-colors"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 pb-5">
          <p className="mb-3 text-sm text-muted">What kind of channel?</p>
          <div className="grid grid-cols-2 gap-3">
            <ChannelTypeCard
              selected={channelType === "chat"}
              icon={<Hash className="h-4 w-4" />}
              title="Chat channel"
              description="Open discussion for the team - not tied to any project."
              onClick={() => setChannelType("chat")}
            />
            <ChannelTypeCard
              selected={channelType === "project"}
              icon={<FolderGit2 className="h-4 w-4" />}
              title="Project channel"
              description={projectDisabledReason ?? "Creates a new project, shared with this team, with its own channel."}
              onClick={onChooseProject ?? (() => undefined)}
              disabled={Boolean(projectDisabledReason)}
            />
          </div>

          {channelType === "chat" && (
            <label className="mt-5 block">
              <span className="mb-2 block text-sm text-muted">Channel name</span>
              <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 focus-within:border-border-strong">
                <Hash className="h-4 w-4 flex-shrink-0 text-subtle" />
                <input
                  autoFocus
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="announcements"
                  className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-faint"
                  onKeyDown={(event) => {
                    if (event.key === "Enter") submitChat();
                  }}
                />
              </div>
              {slug.length > 0 && (
                <p className="mt-1.5 text-xs text-subtle">
                  {isDuplicate
                    ? `#${slug} already exists in ${teamName}.`
                    : `Will be created as #${slug}.`}
                </p>
              )}
            </label>
          )}
        </div>

        {channelType === "chat" && (
          <div className="flex justify-end border-t border-border bg-background/40 px-5 py-3">
            <button
              type="button"
              className="rounded-lg bg-chip px-4 py-2 text-sm font-medium text-chip-foreground hover:bg-chip-hover transition-colors disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-chip"
              disabled={!canCreate}
              onClick={submitChat}
            >
              Create channel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// Same card language as CreateProjectModal's own TypeCard, so the two
// modals - "New channel" and, if you pick the project half, "Create
// project" right after it - read as one continuous flow rather than two
// differently-designed screens bolted together.
function ChannelTypeCard({
  selected,
  icon,
  title,
  description,
  onClick,
  disabled = false,
}: {
  selected: boolean;
  icon: ReactNode;
  title: string;
  description: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-xl border p-4 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
        selected
          ? "border-accent bg-accent/10"
          : "border-border bg-background/30 hover:border-border-strong disabled:hover:border-border"
      }`}
    >
      <div className="mb-6 flex items-start justify-between">
        <span className={selected ? "text-accent" : "text-subtle"}>{icon}</span>
        <span
          className={`flex h-4 w-4 items-center justify-center rounded-full border ${
            selected ? "border-accent bg-accent" : "border-border-strong"
          }`}
        >
          {selected && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
        </span>
      </div>
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="mt-1 text-xs leading-relaxed text-subtle">{description}</p>
    </button>
  );
}
