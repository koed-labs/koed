"use client";

import { CURRENT_USER_ID, resolveAgents } from "@/lib/collab";
import { projectsForTeam } from "@/lib/workspace";
import { buildPublicSquareModel } from "@/lib/public-square-view";
import type { PublicSquarePublication } from "@/lib/public-square";
import { PublicSquareView } from "./PublicSquareView";
import { TeamShell } from "./TeamShell";
import { useWorkspace } from "./WorkspaceProvider";

/** Presentation-only fallback; these examples never enter the Team authority. */
export function PublicSquarePreview() {
  const { activeTeam, workspace } = useWorkspace();
  if (!activeTeam) return null;
  const projects = projectsForTeam(workspace, activeTeam.id);
  const projectNames = new Map(
    projects.map((project) => [project.id, project.name])
  );
  const agents = resolveAgents(
    workspace.projectAgents,
    workspace.agentDefinitions
  ).filter((agent) => projectNames.has(agent.projectId));
  const ownerName = (id: string) =>
    id === CURRENT_USER_ID
      ? "You"
      : (activeTeam.members.find((member) => member.id === id)?.name ??
        "Team member");
  const items: PublicSquarePublication[] = agents
    .filter((agent) => agent.status !== "idle")
    .map((agent) => ({
      id: `preview:${agent.id}`,
      jobId: `preview:${agent.id}`,
      agentId: agent.definitionId,
      agentName: agent.name,
      ownerId: agent.ownerId,
      ownerName: ownerName(agent.ownerId),
      projectId: agent.projectId,
      projectName: projectNames.get(agent.projectId)!,
      status: agent.status === "waiting" ? "waiting" : "running",
      lastKnownStatus: null,
      startedAt: null,
      waitingOn: null,
      ownerExecutionId: null,
      phase: null,
      phaseObservedAt: null,
      publishedAt: new Date(agent.createdAt).toISOString(),
      updatedAt: new Date(agent.createdAt).toISOString(),
      completedAt: null,
      lastSeenAt: null,
      ownerLeftTeam: false,
      sharedBrief: null,
      version: 1,
      canEditBrief: false,
      canRemoveRetainedBrief: false
    }));
  const model = buildPublicSquareModel({
    items,
    projects,
    viewerId: CURRENT_USER_ID
  });
  return (
    <TeamShell heading="Public Square" wallpaper>
      <div className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6">
        <p className="mb-4 text-xs text-subtle">
          Local preview examples · not connected to a Team backend
        </p>
        <PublicSquareView
          teamName={activeTeam.name}
          viewerId={CURRENT_USER_ID}
          jobs={model.jobs}
          rooms={model.rooms}
          idleAgents={agents
            .filter((agent) => agent.status === "idle")
            .map((agent) => ({
              agentId: agent.id,
              agentName: agent.name,
              ownerId: agent.ownerId,
              ownerName: ownerName(agent.ownerId)
            }))}
          historicalItems={[]}
          hasMore={false}
          loadingMore={false}
          getVisibleBrief={(item) => item.sharedBrief}
          renderProjectActions={() => null}
          renderPublication={(item) => (
            <div className="space-y-2 text-sm">
              <p>
                {item.agentName} · {item.ownerName}
              </p>
              <p className="text-subtle">Details not shared</p>
              <p className="text-xs text-faint">
                Connect Studio to a Team backend to use live Job controls.
              </p>
            </div>
          )}
        />
      </div>
    </TeamShell>
  );
}
