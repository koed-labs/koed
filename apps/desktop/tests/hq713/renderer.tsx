import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Project } from "@koed/shared";
import type { ProjectsDesktopApi } from "../../src/ipc/projects-protocol.js";
import { HqShell } from "../../src/renderer/hq/HqShell.js";
import { HqSidebar } from "../../src/renderer/hq/HqSidebar.js";
import { HqProjectView } from "../../src/renderer/hq/project/HqProjectView.js";
import { SharedProjectStore } from "../../src/renderer/hq/shared-project/shared-project-store.js";
import { HqShareSheet } from "../../src/renderer/hq/share-project/HqShareSheet.js";
import { NowView } from "../../src/renderer/hq/now/NowView.js";
import {
  createCollaborationRendererClient,
  type CollaborationRendererBridge
} from "../../src/collaboration/renderer-client.js";
import "../../src/renderer/index.css";

type Profile = {
  ownerId: string;
  name: string;
  projectId: string;
  shareReviewProjectId: string;
  teamUrl: string;
  teamBackendId: string;
};
const bridge = (
  window as unknown as {
    hq713: {
      profile(): Promise<Profile>;
      projects: ProjectsDesktopApi;
      collaboration: CollaborationRendererBridge;
    };
  }
).hq713;

// These are the production HQ components, stores and typed preload. Business
// data comes from each user's listening Personal/Team services through real IPC.
function Hq713Desktop() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [extra, setExtra] = useState<"share" | "invites" | null>(null);
  const [profileKey, setProfileKey] = useState<string | null>(null);
  const store = useMemo(() => new SharedProjectStore(bridge.projects), []);
  const collaboration = useMemo(
    () => createCollaborationRendererClient(bridge.collaboration),
    []
  );
  // The live local broker already has a browser-enrolled backend. The main
  // process supplies its validated active URL for Now's read-only authority
  // check; all snapshots and invitation commands still use the real client.
  const enrolledCollaboration = useMemo(
    () => ({
      ...collaboration,
      currentRemoteUrl: () =>
        collaboration.current()?.connection.backendId === profile?.teamBackendId
          ? (profile?.teamUrl ?? null)
          : null
    }),
    [collaboration, profile?.teamBackendId, profile?.teamUrl]
  );
  useEffect(() => {
    let live = true;
    void Promise.all([bridge.profile(), bridge.projects.list()])
      .then(([identity, rows]) => {
        if (!live) return;
        setProfile(identity);
        setProjects(rows);
        setSelected(identity.projectId);
      })
      .catch((cause: unknown) => setError(String(cause)));
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    const showShare = () => {
      if (!profile) return;
      void collaboration
        .load()
        .then((snapshot) => {
          if (
            snapshot.connection.backendId !== profile.teamBackendId ||
            snapshot.navigation.personalOwner.id !== profile.ownerId
          )
            throw new Error("The enrolled Team authority changed.");
          setProfileKey(
            `${snapshot.connection.backendId}|${snapshot.connection.connectedAt ?? ""}|${profile.teamUrl}`
          );
          setExtra("share");
        })
        .catch((cause: unknown) => setError(String(cause)));
    };
    const showInvites = () => {
      if (!profile) return;
      void collaboration
        .load()
        .then((snapshot) => {
          if (
            snapshot.connection.backendId !== profile.teamBackendId ||
            snapshot.navigation.personalOwner.id !== profile.ownerId
          )
            throw new Error("The enrolled Team authority changed.");
          setProfileKey(
            `${snapshot.connection.backendId}|${snapshot.connection.connectedAt ?? ""}|${profile.teamUrl}`
          );
          setExtra("invites");
        })
        .catch((cause: unknown) => setError(String(cause)));
    };
    const hide = () => setExtra(null);
    window.addEventListener("hq713:show-share", showShare);
    window.addEventListener("hq713:show-invites", showInvites);
    window.addEventListener("hq713:hide-extra", hide);
    return () => {
      window.removeEventListener("hq713:show-share", showShare);
      window.removeEventListener("hq713:show-invites", showInvites);
      window.removeEventListener("hq713:hide-extra", hide);
    };
  }, [profile, collaboration]);
  useEffect(() => {
    const reload = () => setRefresh((value) => value + 1);
    window.addEventListener("hq713:refresh", reload);
    return () => window.removeEventListener("hq713:refresh", reload);
  }, []);
  const project = projects.find(({ id }) => id === selected);
  if (!profile || !project) return <p role="status">{error || "Loading HQ"}</p>;
  const showingNow = extra === "invites";
  const route = showingNow
    ? ({ kind: "home" } as const)
    : ({ kind: "project", projectId: project.id } as const);
  return (
    <HqShell
      title={showingNow ? "Now" : project.name}
      route={route}
      sidebar={
        <HqSidebar
          projects={[]}
          personalProjects={projects}
          groupsReady
          accountIdentity={{ displayName: profile.name }}
          route={route}
          nowActive={showingNow}
          onOpenNow={() => setExtra("invites")}
          onSelectProject={setSelected}
          onSelectConversation={() => undefined}
          onOpenSearchAndCommands={() => undefined}
        />
      }
      contextAvailable={false}
    >
      {error ? <p role="alert">{error}</p> : null}
      {extra !== "invites" ? (
        <HqProjectView
          project={project}
          personalProjects={projects}
          graphProjects={[]}
          projectsApi={bridge.projects}
          sharedProjectStore={store}
          ownerId={profile.ownerId}
          profileKey={profile.ownerId}
          sharedRefreshSignal={refresh}
          onSelectConversation={() => undefined}
          onOpenPrivateHq={() => undefined}
          rightColumnVisible={false}
        />
      ) : null}
      {extra === "share" ? (
        <HqShareSheet
          open
          project={
            projects.find(({ id }) => id === profile.shareReviewProjectId) ??
            null
          }
          projectsApi={bridge.projects}
          collaboration={collaboration}
          identityKey={profileKey ?? profile.ownerId}
          onClose={() => setExtra(null)}
          onShared={() => undefined}
        />
      ) : null}
      {extra === "invites" ? (
        <NowView
          projects={[]}
          personalProjects={projects}
          projectsApi={bridge.projects}
          invitationsClient={enrolledCollaboration}
          approvals={[]}
          projectsReady
          ownerId={profile.ownerId}
          profileKey={profileKey}
          onSelectProject={setSelected}
          onSelectConversation={() => undefined}
        />
      ) : null}
    </HqShell>
  );
}
createRoot(document.getElementById("root")!).render(<Hq713Desktop />);
