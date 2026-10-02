"use client";

import { User, Settings, Plus, PanelLeftOpen } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Tooltip } from "./Tooltip";
import { useWorkspace } from "./WorkspaceProvider";
import { useActionItems } from "./useActionItems";
import { useSidebar } from "./SidebarContext";

export function GlobalNav() {
  const router = useRouter();
  const pathname = usePathname();
  const { workspace, activeTeamId, openHome, setActiveTeamId } = useWorkspace();
  const { personalBadge, teamBadge } = useActionItems();
  const { isOpen, isNarrowScreen, toggleSidebar } = useSidebar();

  const openPersonal = () => {
    openHome();
    router.push("/personal-preview");
  };

  const openTeam = (teamId: string) => {
    setActiveTeamId(teamId);
    router.push("/collaboration");
  };

  return (
    <nav
      aria-label="Workspace switcher"
      className="w-[72px] h-dvh min-h-0 overflow-y-auto [&>*]:shrink-0 bg-sidebar border-r border-border flex flex-col items-center py-4 flex-shrink-0 pt-10 drag-region relative z-20"
    >
      <Tooltip content="Personal Workspace" side="right">
        <button
          type="button"
          onClick={openPersonal}
          className={`relative w-10 h-10 rounded-xl bg-surface-hover text-foreground flex items-center justify-center cursor-pointer hover:bg-surface-active transition-colors mb-4 no-drag ${
            !activeTeamId
              ? "ring-2 ring-accent ring-offset-2 ring-offset-sidebar"
              : ""
          }`}
        >
          <User className="w-5 h-5" />
          <RailBadge count={personalBadge} />
        </button>
      </Tooltip>

      <div className="w-8 h-px bg-surface-hover my-2 no-drag" />

      {(isNarrowScreen || !isOpen) && (
        <Tooltip
          content={
            isOpen ? "Close workspace navigation" : "Open workspace navigation"
          }
          side="right"
        >
          <button
            type="button"
            aria-label={
              isOpen
                ? "Close workspace navigation"
                : "Open workspace navigation"
            }
            aria-controls="context-navigation"
            aria-expanded={isOpen}
            onClick={toggleSidebar}
            className="w-10 h-10 rounded-xl text-muted flex items-center justify-center cursor-pointer hover:bg-surface-hover hover:text-foreground transition-colors no-drag mb-2"
          >
            <PanelLeftOpen className="w-5 h-5" />
          </button>
        </Tooltip>
      )}

      <div className="flex flex-col gap-3 mt-2 no-drag">
        {workspace.teams.map((team, index) => (
          <Tooltip key={team.id} content={team.name} side="right">
            <button
              type="button"
              onClick={() => openTeam(team.id)}
              className={`relative w-10 h-10 rounded-[20px] hover:rounded-xl bg-surface border border-border text-muted flex items-center justify-center cursor-pointer hover:bg-surface-hover hover:text-foreground transition-all duration-200 ${
                activeTeamId === team.id
                  ? "rounded-xl bg-surface-hover text-foreground ring-2 ring-accent ring-offset-2 ring-offset-sidebar"
                  : ""
              }`}
            >
              <span className="font-semibold text-sm">{`T${index + 1}`}</span>
              <RailBadge count={teamBadge(team.id)} />
            </button>
          </Tooltip>
        ))}
        <Tooltip content="Add New Team" side="right">
          <div className="w-10 h-10 rounded-[20px] hover:rounded-xl bg-surface border border-border text-muted flex items-center justify-center cursor-pointer hover:bg-surface-hover hover:text-foreground transition-all duration-200">
            <Plus className="w-5 h-5" />
          </div>
        </Tooltip>
      </div>

      <div className="mt-auto no-drag">
        <Tooltip content="Settings" side="right">
          <Link
            href="/settings"
            className={`w-10 h-10 rounded-xl text-muted flex items-center justify-center cursor-pointer hover:text-foreground transition-colors ${
              pathname === "/settings"
                ? "bg-surface-hover text-foreground ring-2 ring-accent ring-offset-2 ring-offset-sidebar"
                : ""
            }`}
            aria-label="Settings"
          >
            <Settings className="w-5 h-5" />
          </Link>
        </Tooltip>
      </div>
    </nav>
  );
}

function RailBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold leading-none text-white ring-2 ring-sidebar">
      {count > 9 ? "9+" : count}
    </span>
  );
}
