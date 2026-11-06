import { useEffect, useRef, type ReactNode } from "react";
import {
  Sidebar,
  SidebarProvider,
  SidebarHeader,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarInset,
  SidebarTrigger,
  useSidebar
} from "@koed/ui";
import { ChevronLeft, ChevronRight, Folder, Settings } from "lucide-react";
import { ProjectSidebar, type SidebarManagement } from "./ProjectSidebar.js";
import { DesktopUpdateIndicator } from "../update/DesktopUpdate.js";
import type { DesktopUpdateController } from "../update/use-desktop-update.js";
import type {
  NavigationRoute,
  SidebarProject
} from "./project-sidebar-model.js";
import "./navigation.css";

type Props = {
  children: ReactNode;
  projects: readonly SidebarProject[];
  route: NavigationRoute;
  scopeKey: string | null;
  title?: string;
  // A Project for the sidebar to expand; see ProjectSidebar.
  revealProject?: { projectId: string; key: number } | null;
  projectName?: string;
  profileName: string;
  onSelect: (route: NavigationRoute) => void;
  onHome: () => void;
  onSettings: () => void;
  onProfile: () => void;
  onBack: () => void;
  onForward: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
  loading?: boolean;
  servicesStarting?: boolean;
  inventoryReady?: boolean;
  error?: string | null;
  onRetry: () => void;
  management?: SidebarManagement;
  update?: DesktopUpdateController;
  onOpenAbout?: () => void;
};
export function NavigationShell(props: Props) {
  return (
    <SidebarProvider
      className="v1-app v1-navigation"
      style={{ "--sidebar-width": "280px" } as React.CSSProperties}
    >
      <ShellContent {...props} />
    </SidebarProvider>
  );
}
function ShellContent(props: Props) {
  const { isMobile, setOpen, setOpenMobile } = useSidebar();
  const searchRef = useRef<HTMLInputElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const routeKey = JSON.stringify(props.route);
  useEffect(() => {
    setOpenMobile(false);
    mainRef.current?.focus({ preventScroll: true });
  }, [routeKey, setOpenMobile]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (isMobile) setOpenMobile(true);
        else setOpen(true);
        requestAnimationFrame(() => searchRef.current?.focus());
      }
      if (event.altKey && event.key === "ArrowLeft" && props.canGoBack) {
        event.preventDefault();
        props.onBack();
      }
      if (event.altKey && event.key === "ArrowRight" && props.canGoForward) {
        event.preventDefault();
        props.onForward();
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [
    isMobile,
    setOpen,
    setOpenMobile,
    props.canGoBack,
    props.canGoForward,
    props.onBack,
    props.onForward
  ]);
  const railButton = (
    label: string,
    icon: ReactNode,
    onClick: () => void,
    active = false
  ) => (
    <SidebarMenuItem>
      <SidebarMenuButton
        className="v1-nav-rail-button"
        aria-label={label}
        title={label}
        isActive={active}
        onClick={onClick}
      >
        {icon}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
  return (
    <>
      <Sidebar
        collapsible="none"
        className="v1-nav-rail"
        aria-label="Koed navigation"
      >
        <SidebarHeader>
          <SidebarMenu>
            {railButton(
              "Koed, home",
              <span className="v1-logo">
                <i />
                <i />
                <i />
                <i />
              </span>,
              props.onHome,
              true
            )}
          </SidebarMenu>
        </SidebarHeader>
        <SidebarFooter>
          <SidebarMenu>
            {railButton("Settings", <Settings />, props.onSettings)}
            {railButton(
              "Profile",
              <span className="v1-profile-badge">
                {props.profileName.charAt(0).toUpperCase() || "K"}
              </span>,
              props.onProfile
            )}
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
      <Sidebar
        collapsible="offcanvas"
        className="v1-app v1-navigation-sidebar"
        aria-label="Conversations and Projects"
      >
        <ProjectSidebar
          key={props.scopeKey}
          projects={props.projects}
          route={props.route}
          scopeKey={props.scopeKey}
          onSelect={(route) => {
            setOpenMobile(false);
            props.onSelect(route);
          }}
          searchRef={searchRef}
          loading={props.loading}
          servicesStarting={props.servicesStarting}
          inventoryReady={props.inventoryReady}
          error={props.error}
          onRetry={props.onRetry}
          reveal={props.revealProject ?? null}
          management={props.management}
        />
      </Sidebar>
      <SidebarInset className="v1-navigation-main" ref={mainRef} tabIndex={-1}>
        <header className="v1-navigation-bar">
          <SidebarTrigger
            aria-label={isMobile ? "Open navigation" : "Toggle navigation"}
          />
          <div className="v1-navigation-history">
            <button
              type="button"
              aria-label="Go back"
              disabled={!props.canGoBack}
              onClick={props.onBack}
            >
              <ChevronLeft />
            </button>
            <button
              type="button"
              aria-label="Go forward"
              disabled={!props.canGoForward}
              onClick={props.onForward}
            >
              <ChevronRight />
            </button>
          </div>
          {props.projectName && (
            <span className="v1-navigation-crumb">
              <Folder />
              {props.projectName}
              <ChevronRight />
            </span>
          )}
          <span className="v1-navigation-title">
            {props.title ?? "Conversation"}
          </span>
          {props.update && props.onOpenAbout ? (
            <DesktopUpdateIndicator
              update={props.update}
              onOpen={props.onOpenAbout}
            />
          ) : null}
        </header>
        <div className="v1-navigation-content">{props.children}</div>
      </SidebarInset>
    </>
  );
}
