"use client";

import { useEffect, useRef } from "react";
import { ProjectSidebar } from "./ProjectSidebar";
import { TeamSidebar } from "./TeamSidebar";
import { useSidebar } from "./SidebarContext";
import { useWorkspace } from "./WorkspaceProvider";

export function ContextSidebar() {
  const { activeTeamId } = useWorkspace();
  const { isOpen, toggleSidebar } = useSidebar();
  const mobileDefaultApplied = useRef(false);

  useEffect(() => {
    if (!activeTeamId || mobileDefaultApplied.current) return;
    mobileDefaultApplied.current = true;
    if (window.matchMedia("(max-width: 767px)").matches && isOpen) {
      // Start the narrow team view on its content, with navigation available on demand.
      toggleSidebar();
    }
  }, [activeTeamId, isOpen, toggleSidebar]);

  useEffect(() => {
    if (!activeTeamId || !isOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && window.matchMedia("(max-width: 767px)").matches) {
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeTeamId, isOpen, toggleSidebar]);

  if (activeTeamId) {
    return (
      <>
        {isOpen && (
          <button
            type="button"
            aria-label="Close team navigation"
            className="fixed inset-y-0 left-[72px] right-0 z-30 bg-black/35 md:hidden"
            onClick={toggleSidebar}
          />
        )}
        <div className={isOpen ? "fixed inset-y-0 left-[72px] z-40 max-w-[calc(100vw-72px)] md:static md:z-auto md:max-w-none" : "hidden md:block"}>
          <TeamSidebar />
        </div>
      </>
    );
  }
  return <ProjectSidebar />;
}
