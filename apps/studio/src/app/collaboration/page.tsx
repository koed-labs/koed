"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { AlertCircle, LoaderCircle, RefreshCw } from "lucide-react";
import { CollabSessionProvider } from "@/components/CollabSessionContext";
import { CollabWorkspace } from "@/components/CollabWorkspace";
import { ContextSidebar } from "@/components/ContextSidebar";
import { DesktopCollaborationRecoveryRail } from "@/components/desktop-collaboration/DesktopCollaborationStudio";
import { TeamChannelWorkspace } from "@/components/desktop-collaboration/TeamChannelWorkspace";
import { GlobalNav } from "@/components/GlobalNav";
import { SidebarProvider } from "@/components/SidebarContext";
import {
  useWorkspace,
  WorkspaceProvider
} from "@/components/WorkspaceProvider";
import { HostedStudio } from "@/components/hosted/HostedStudio";
import {
  StudioCollaborationClient,
  StudioCollaborationRequestError
} from "@/lib/studio-collaboration-client";
import type { CollaborationSnapshot } from "@koed/shared/collaboration";
import {
  studioNotificationNavigationSchema,
  type StudioNotificationNavigation
} from "@koed/shared/studio-notifications";

function CollaborationPreview() {
  const { activeTeamId, hydrated, setActiveTeamId, workspace } = useWorkspace();

  useEffect(() => {
    if (hydrated && !activeTeamId && workspace.teams.length > 0) {
      setActiveTeamId(workspace.teams[0].id);
    }
  }, [activeTeamId, hydrated, setActiveTeamId, workspace.teams]);

  return (
    <div className="relative flex h-full min-h-0 w-full">
      <GlobalNav />
      {hydrated && activeTeamId && (
        <>
          <ContextSidebar />
          <main className="min-h-0 min-w-0 flex-1">
            <CollabWorkspace />
          </main>
        </>
      )}
    </div>
  );
}

export default function CollaborationPage() {
  if (process.env.NEXT_PUBLIC_KOED_STUDIO_HOSTED === "1") {
    return (
      <Suspense fallback={null}>
        <HostedStudio view="collaboration" />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={null}>
      <CollaborationRuntime />
    </Suspense>
  );
}

type CollaborationRouteState =
  | { mode: "studio"; snapshot: CollaborationSnapshot }
  | { mode: "preview" | "unavailable" }
  | { mode: "loading" };

const collaborationAccessKey = (snapshot: CollaborationSnapshot) =>
  JSON.stringify({
    backendId: snapshot.connection.backendId ?? null,
    principalId: snapshot.navigation.teamPrincipal?.id ?? null,
    teams: snapshot.navigation.teams
      .map((team) => ({
        id: team.id,
        role: team.role,
        lifecycle: team.lifecycle,
        membershipVersion: team.membershipVersion ?? null,
        projectIds: team.sharedProjects.map((project) => project.id).sort(),
        workspaces: team.workspaces
          .map((workspace) => ({
            id: workspace.id,
            access: workspace.access,
            lifecycle: workspace.lifecycle
          }))
          .sort((left, right) => left.id.localeCompare(right.id))
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
  });

function CollaborationRuntime() {
  const searchParams = useSearchParams();
  const notificationNavigation =
    useMemo<StudioNotificationNavigation | null>(() => {
      const teamId = searchParams.get("team");
      const threadId = searchParams.get("thread");
      const messageId = searchParams.get("message");
      if (!teamId || !threadId || !messageId) return null;
      const rootMessageId = searchParams.get("root");
      const parsed = studioNotificationNavigationSchema.safeParse({
        kind: "team_thread",
        teamId,
        threadId,
        messageId,
        rootMessageId
      });
      return parsed.success ? parsed.data : null;
    }, [searchParams]);
  const client = useMemo(() => new StudioCollaborationClient(), []);
  const [route, setRoute] = useState<CollaborationRouteState>({
    mode: "loading"
  });
  const routeRef = useRef(route);
  const requestSequence = useRef(0);

  const refresh = useCallback(
    async (preserveWorkspace = false) => {
      if (routeRef.current.mode === "preview") return;
      const sequence = ++requestSequence.current;
      const previousSnapshot =
        routeRef.current.mode === "studio" ? routeRef.current.snapshot : null;
      if (!preserveWorkspace || !previousSnapshot) {
        routeRef.current = { mode: "loading" };
        setRoute(routeRef.current);
      }
      let result: CollaborationRouteState;
      try {
        result = { mode: "studio", snapshot: await client.loadSession() };
      } catch (error) {
        result =
          error instanceof StudioCollaborationRequestError &&
          error.status === 404 &&
          !previousSnapshot
            ? { mode: "preview" }
            : { mode: "unavailable" };
      }
      if (sequence !== requestSequence.current) return;

      // Native dialogs return focus to this window. Revalidate the same access
      // scope without tearing down the stateful workspace (for example an open
      // Project form). A changed or unavailable authority still replaces it.
      if (
        preserveWorkspace &&
        previousSnapshot &&
        result.mode === "studio" &&
        collaborationAccessKey(previousSnapshot) ===
          collaborationAccessKey(result.snapshot)
      ) {
        routeRef.current = result;
        return;
      }

      routeRef.current = result;
      setRoute(result);
    },
    [client]
  );

  useEffect(() => {
    void refresh();
    const onFocus = () => {
      if (document.visibilityState === "visible") void refresh(true);
    };
    window.addEventListener("focus", onFocus);
    return () => {
      requestSequence.current += 1;
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  if (route.mode === "preview") {
    return (
      <WorkspaceProvider>
        <SidebarProvider>
          <CollabSessionProvider>
            <CollaborationPreview />
          </CollabSessionProvider>
        </SidebarProvider>
      </WorkspaceProvider>
    );
  }
  if (route.mode === "studio") {
    return (
      <TeamChannelWorkspace
        key={collaborationAccessKey(route.snapshot)}
        snapshot={route.snapshot}
        client={client}
        drafts={client}
        onRefresh={() => void refresh()}
        notificationNavigation={notificationNavigation}
      />
    );
  }
  if (route.mode === "unavailable") {
    return (
      <div className="flex h-screen w-full bg-background text-foreground">
        <DesktopCollaborationRecoveryRail />
        <section className="m-auto max-w-md px-6 text-center">
          <AlertCircle className="mx-auto mb-4 h-6 w-6 text-warning" />
          <h1 className="text-lg font-medium">Team connection unavailable</h1>
          <p className="mt-2 text-sm leading-relaxed text-subtle">
            Studio could not load the selected backend connection. Personal
            Workspace and Settings remain available on the left.
          </p>
          <button
            type="button"
            onClick={() => void refresh()}
            className="mt-5 inline-flex items-center gap-2 rounded-md bg-surface px-3 py-2 text-sm text-foreground-secondary transition-colors hover:bg-surface-hover hover:text-foreground"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Retry
          </button>
        </section>
      </div>
    );
  }
  return (
    <div className="flex h-screen w-full bg-background text-muted">
      <DesktopCollaborationRecoveryRail />
      <div className="m-auto">
        <LoaderCircle
          className="h-5 w-5 animate-spin"
          aria-label="Loading Team connection"
        />
      </div>
    </div>
  );
}
