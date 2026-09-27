"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Suspense } from "react";
import { AlertCircle, LoaderCircle, RefreshCw } from "lucide-react";
import { CollabSessionProvider } from "@/components/CollabSessionContext";
import { CollabWorkspace } from "@/components/CollabWorkspace";
import { ContextSidebar } from "@/components/ContextSidebar";
import {
  DesktopCollaborationRecoveryRail,
  DesktopCollaborationStudio
} from "@/components/desktop-collaboration/DesktopCollaborationStudio";
import { GlobalNav } from "@/components/GlobalNav";
import { SidebarProvider } from "@/components/SidebarContext";
import {
  useWorkspace,
  WorkspaceProvider
} from "@/components/WorkspaceProvider";
import { HostedStudio } from "@/components/hosted/HostedStudio";
import {
  loadDesktopCollaboration,
  type DesktopCollaborationLoadResult
} from "@/lib/desktop-collaboration";

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
  return <CollaborationRuntime />;
}

type CollaborationRouteState =
  | DesktopCollaborationLoadResult
  | { mode: "loading" };

function CollaborationRuntime() {
  const [route, setRoute] = useState<CollaborationRouteState>({
    mode: "loading"
  });
  const routeRef = useRef(route);
  const requestSequence = useRef(0);

  const refresh = useCallback(async () => {
    if (routeRef.current.mode === "preview") return;
    const sequence = ++requestSequence.current;
    routeRef.current = { mode: "loading" };
    setRoute(routeRef.current);
    const result = await loadDesktopCollaboration();
    if (sequence !== requestSequence.current) return;
    routeRef.current = result;
    setRoute(result);
  }, []);

  useEffect(() => {
    void refresh();
    const onFocus = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const interval = window.setInterval(() => {
      if (
        document.visibilityState === "visible" &&
        routeRef.current.mode !== "preview"
      ) {
        void refresh();
      }
    }, 30_000);
    window.addEventListener("focus", onFocus);
    return () => {
      requestSequence.current += 1;
      window.clearInterval(interval);
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
  if (route.mode === "desktop") {
    return (
      <DesktopCollaborationStudio
        key={route.snapshot.connection.backendId ?? "no-backend"}
        snapshot={route.snapshot}
        onRetry={refresh}
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
