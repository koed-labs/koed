"use client";

import { CollabSessionProvider } from "@/components/CollabSessionContext";
import { PersonalPreviewWorkspace } from "@/components/PersonalPreviewWorkspace";
import { SidebarProvider } from "@/components/SidebarContext";
import { SidePanelProvider } from "@/components/SidePanelContext";
import { WorkspaceProvider } from "@/components/WorkspaceProvider";

export default function PersonalPreviewPage() {
  return (
    <WorkspaceProvider>
      <SidebarProvider>
        <SidePanelProvider>
          <CollabSessionProvider>
            <PersonalPreviewWorkspace />
          </CollabSessionProvider>
        </SidePanelProvider>
      </SidebarProvider>
    </WorkspaceProvider>
  );
}
