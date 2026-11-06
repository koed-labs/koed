import { useEffect, useRef, useState } from "react";
import {
  Button,
  Dialog,
  DialogClose,
  DialogPopup,
  DialogTitle
} from "@koed/ui";
import { X } from "lucide-react";
import type { ComponentStatus, DesktopApi } from "../../types.js";
import type { DesktopStatusStore } from "../services/desktop-commands.js";
import type { ThemeStore } from "../state/theme.js";
import { useDesktopStatus } from "../state/use-status.js";
import { KoedLogo } from "../KoedLogo.js";
import {
  DesktopUpdateDot,
  DesktopUpdatePanel
} from "../update/DesktopUpdate.js";
import type { DesktopUpdateController } from "../update/use-desktop-update.js";
import {
  useSettingsNavigation,
  type V1SettingsPage
} from "./settings-navigation.js";
import { SettingsTools, SettingsToolPage } from "./settings-tools.js";
import { GeneralPreferences } from "./settings-general.js";
import { SettingsModels } from "./settings-ai.js";
import {
  SettingsServicePage,
  SettingsServicesOverview,
  settingsServiceComponents,
  ServiceActions,
  ServiceStatusFooter,
  type ServiceAction
} from "./settings-services.js";
import {
  Group,
  PageHeading,
  sections,
  type Section
} from "./settings-controls.js";
import "./settings.css";

const tabs = (Object.keys(sections) as Section[]).map((id) => ({
  id,
  ...sections[id]
}));
const errorText = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);
export type V1SettingsTab = Section;
export type V1SettingsProps = {
  statusStore: DesktopStatusStore;
  themeStore: ThemeStore;
  onClose: () => void;
  initialTab?: V1SettingsTab | "agent";
  initialPage?: V1SettingsPage;
  cliInstall?: DesktopApi["cliInstall"];
  onRestartOnboarding?: () => Promise<void> | void;
  launchAtStartup?: DesktopApi["launchAtStartup"];
  presentationPreferences?: DesktopApi["presentationPreferences"];
  localAiClients?: DesktopApi["localAiClients"];
  update?: DesktopUpdateController;
  version?: string;
};
export function V1Settings({
  statusStore,
  themeStore,
  onClose,
  initialTab = "general",
  initialPage,
  cliInstall = window.koedDesktop?.cliInstall,
  onRestartOnboarding,
  launchAtStartup = window.koedDesktop?.launchAtStartup,
  presentationPreferences = window.koedDesktop?.presentationPreferences,
  localAiClients = window.koedDesktop?.localAiClients,
  update,
  version
}: V1SettingsProps) {
  const navigation = useSettingsNavigation(initialTab, initialPage);
  const { tab, page, setTab } = navigation;
  const [serviceBusy, setServiceBusy] = useState<ServiceAction | null>(null);
  const [serviceError, setServiceError] = useState<string | null>(null);
  const [serviceNotice, setServiceNotice] = useState<string | null>(null);
  const servicesRefreshDeadline = useRef<number | null>(null);
  const snapshot = useDesktopStatus(statusStore);
  const activeTab = useRef<HTMLButtonElement>(null);
  const [opener] = useState(() =>
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
  );
  useEffect(() => {
    void statusStore.refresh();
  }, [statusStore]);
  useEffect(() => {
    if (tab === "services") void statusStore.refresh();
  }, [tab, page, statusStore]);
  const servicesStarting =
    tab === "services" &&
    settingsServiceComponents(snapshot.status).some(
      ([, component]) => component.state === "starting"
    );
  useEffect(() => {
    if (!servicesStarting) {
      servicesRefreshDeadline.current = null;
      return;
    }
    // A service can remain "starting" indefinitely; keep extra UI polling bounded.
    const now = Date.now();
    servicesRefreshDeadline.current ??= now + 60_000;
    if (
      snapshot.error ||
      snapshot.busyCommand ||
      now + 1500 > servicesRefreshDeadline.current
    )
      return;
    const timeout = setTimeout(() => void statusStore.refresh(), 1500);
    return () => clearTimeout(timeout);
  }, [
    servicesStarting,
    snapshot.revision,
    snapshot.error,
    snapshot.busyCommand,
    statusStore
  ]);
  const runService = async (action: ServiceAction) => {
    if (serviceBusy || snapshot.busyCommand) return;
    setServiceBusy(action);
    setServiceError(null);
    setServiceNotice(null);
    try {
      if (action === "restart") {
        const stopped = await window.koedDesktop?.invoke<{
          ok?: boolean;
          message?: string;
          error?: string;
        }>("stop");
        if (!stopped || stopped.ok === false)
          throw new Error(
            stopped?.message ?? stopped?.error ?? "Koed could not stop."
          );
      }
      if (action === "start" || action === "restart") {
        const started = await statusStore.run<{
          ok?: boolean;
          message?: string;
          error?: string;
        }>("start");
        if (started?.ok === false)
          throw new Error(
            started.message ?? started.error ?? "Koed could not start."
          );
      } else if (action === "open_logs") {
        const opened = await statusStore.run<{ ok?: boolean; error?: string }>(
          "open_logs"
        );
        if (opened?.ok === false)
          throw new Error(opened.error ?? "Logs could not be opened.");
      } else if (action === "doctor") {
        const result = await statusStore.run<{
          ok?: boolean;
          message?: string;
          error?: string;
        }>("doctor");
        if (!result || result.ok === false)
          throw new Error(
            result?.error ??
              result?.message ??
              "Diagnostics found issues that need attention."
          );
        setServiceNotice("Diagnostics completed.");
      } else {
        const clipboard = window.koedDesktop?.clipboard;
        if (!clipboard) throw new Error("Clipboard is unavailable.");
        const current = statusStore.current();
        const state = current.status;
        if (!state) throw new Error("Service status is unavailable.");
        const component = (value?: ComponentStatus | null) =>
          value ? { state: value.state } : null;
        const report = {
          generatedAt: state?.generatedAt ?? null,
          components: {
            api: component(state?.api),
            database: component(state?.database),
            localAiRuntime: component(state?.localAiRuntime),
            captureHook: component(state?.captureHook),
            embeddingService: component(state?.embeddingService),
            lcmSummaryService: component(state?.lcmSummaryService)
          }
        };
        await clipboard.writeText(JSON.stringify(report, null, 2));
        setServiceNotice("Diagnostics copied.");
      }
      if (action === "start" || action === "restart") {
        servicesRefreshDeadline.current = null;
        await statusStore.refresh();
      }
    } catch (cause) {
      setServiceError(errorText(cause));
    } finally {
      setServiceBusy(null);
    }
  };
  const status = snapshot.status;
  const serviceControlsDisabled = !!serviceBusy || !!snapshot.busyCommand;
  return (
    <Dialog
      open
      onOpenChange={(open, event) => {
        if (open) return;
        if (page && event.reason === "escape-key") {
          event.cancel();
          navigation.back();
        } else onClose();
      }}
    >
      <DialogPopup
        className="v1-settings-popup v1-app v1-project-ui"
        showCloseButton={false}
        initialFocus={activeTab}
        finalFocus={() => opener}
      >
        <DialogTitle className="sr-only">Desktop Settings</DialogTitle>
        <nav className="settings-nav" aria-label="Settings sections">
          <div className="nav-title">
            <KoedLogo className="settings-brand" />
            Settings
          </div>
          <div
            className="section-tabs"
            role="tablist"
            aria-label="Settings sections"
            onKeyDown={(event) => {
              const direction =
                event.key === "ArrowDown" || event.key === "ArrowRight"
                  ? 1
                  : event.key === "ArrowUp" || event.key === "ArrowLeft"
                    ? -1
                    : 0;
              if (!direction && event.key !== "Home" && event.key !== "End")
                return;
              event.preventDefault();
              const index =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? tabs.length - 1
                    : (tabs.findIndex((item) => item.id === tab) +
                        direction +
                        tabs.length) %
                      tabs.length;
              const next = tabs[index]!;
              setTab(next.id);
              event.currentTarget
                .querySelector<HTMLButtonElement>(`#v1-settings-tab-${next.id}`)
                ?.focus();
            }}
          >
            {tabs.map(({ id, label, icon: Icon }) => (
              <Button
                key={id}
                ref={id === tab ? activeTab : undefined}
                variant="ghost"
                className="section-link"
                role="tab"
                id={"v1-settings-tab-" + id}
                aria-controls="v1-settings-panel"
                aria-selected={tab === id}
                tabIndex={tab === id ? 0 : -1}
                onClick={() => setTab(id)}
              >
                <Icon />
                {label}
                {id === "about" && <DesktopUpdateDot update={update} />}
              </Button>
            ))}
          </div>
          <span className="nav-version">
            <KoedLogo className="footer-brand" />
            Koed Desktop{" "}
            <span>{version ?? update?.state?.installedVersion}</span>
          </span>
        </nav>
        <div
          ref={navigation.bodyRef}
          className="settings-scroll"
          role="tabpanel"
          id="v1-settings-panel"
          aria-labelledby={"v1-settings-tab-" + tab}
        >
          {!page && <PageHeading page={tab} />}
          {tab === "general" &&
            (!page ? (
              <>
                <GeneralPreferences
                  {...{
                    themeStore,
                    launchAtStartup,
                    presentationPreferences,
                    onRestartOnboarding
                  }}
                />
                <SettingsTools api={cliInstall} onOpen={navigation.openPage} />
              </>
            ) : (
              (page === "privacy" || page === "cli") && (
                <SettingsToolPage
                  key={page}
                  tool={page}
                  api={cliInstall}
                  onBack={navigation.back}
                />
              )
            ))}
          {tab === "ai" && (
            <SettingsModels
              api={localAiClients}
              statusStore={statusStore}
              snapshot={snapshot}
            />
          )}
          {tab === "services" && (
            <>
              {page === "health" || page === "embedding" ? (
                <SettingsServicePage
                  page={page}
                  status={snapshot.error ? null : status}
                  onBack={navigation.back}
                />
              ) : (
                <SettingsServicesOverview
                  status={snapshot.error ? null : status}
                  embeddingSupported={status?.embeddingState !== undefined}
                  onOpen={navigation.openPage}
                />
              )}
              {snapshot.error && <p role="alert">{snapshot.error}</p>}
              {!page && (
                <>
                  {serviceError && <p role="alert">{serviceError}</p>}
                  <ServiceActions
                    running={status?.api?.state === "healthy"}
                    busy={serviceBusy}
                    disabled={serviceControlsDisabled}
                    run={(action) => void runService(action)}
                  />
                </>
              )}
              <ServiceStatusFooter
                disabled={serviceControlsDisabled}
                notice={page ? null : serviceNotice}
                updatedAt={status?.generatedAt}
                refresh={() => {
                  servicesRefreshDeadline.current = null;
                  void statusStore.refresh();
                }}
              />
            </>
          )}
          {tab === "about" && (
            <>
              <div className="about-app">
                <KoedLogo className="about-brand" />
                <div>
                  <h3>Koed Desktop</h3>
                  <p>Local memory and AI Client integration</p>
                </div>
              </div>
              <DesktopUpdatePanel update={update} installedVersion={version} />
              <Group title="Your data">
                <div className="pad">
                  Your Koed installation manages your Conversations, Projects,
                  and Memory.
                </div>
              </Group>
            </>
          )}
        </div>
        <DialogClose
          aria-label="Close settings"
          className="close-button"
          render={<Button size="icon-sm" variant="ghost" />}
        >
          <X />
        </DialogClose>
      </DialogPopup>
    </Dialog>
  );
}
