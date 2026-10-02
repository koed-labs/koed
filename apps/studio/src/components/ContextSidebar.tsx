"use client";

import { useEffect, type MouseEvent } from "react";
import { ProjectSidebar } from "./ProjectSidebar";
import { TeamSidebar } from "./TeamSidebar";
import { useSidebar } from "./SidebarContext";
import { useWorkspace } from "./WorkspaceProvider";

export function ContextSidebar() {
  const { activeTeamId } = useWorkspace();
  const { isOpen, toggleSidebar, isNarrowScreen } = useSidebar();

  useEffect(() => {
    if (!isNarrowScreen || !isOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isNarrowScreen, isOpen, toggleSidebar]);

  const closeOnNavigation = (event: MouseEvent) => {
    if (!isNarrowScreen) return;
    const target = event.target;
    if (target instanceof Element && target.closest("a[href]")) toggleSidebar();
  };

  if (activeTeamId) {
    return (
      <>
        {isOpen && isNarrowScreen && (
          <button
            type="button"
            aria-label="Close team navigation"
            className="fixed inset-y-0 left-[72px] right-0 z-30 bg-black/35"
            onClick={toggleSidebar}
          />
        )}
        <div
          id="context-navigation"
          className={
            isOpen
              ? isNarrowScreen
                ? "fixed inset-y-0 left-[72px] z-40 max-w-[calc(100vw-72px)]"
                : "relative z-auto max-w-none"
              : "hidden"
          }
        >
          <TeamSidebar />
        </div>
      </>
    );
  }
  return (
    <>
      {isOpen && isNarrowScreen && (
        <button
          type="button"
          aria-label="Close project navigation"
          className="fixed inset-y-0 left-[72px] right-0 z-30 bg-black/35"
          onClick={toggleSidebar}
        />
      )}
      {isOpen && (
        <div
          id="context-navigation"
          className={
            isNarrowScreen
              ? "fixed inset-y-0 left-[72px] z-40 max-w-[calc(100vw-72px)]"
              : "relative z-auto"
          }
          onClick={closeOnNavigation}
        >
          <ProjectSidebar previewMode mobileOverlay={isNarrowScreen} />
        </div>
      )}
    </>
  );
}
