import { AlertTriangle, Check, Copy, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Button, Input, Spinner } from "@koed/ui";
import type { DesktopApi } from "../../../types.js";
import { FlowSettingsFieldset } from "./FlowSettingsFieldset.js";
import { assignmentFrom, flows } from "./local-ai-client-settings-helpers.js";
import { useLocalAiClientSettings } from "./useLocalAiClientSettings.js";

// Keep the search implementation available while its matching behavior is repaired.
const AGENT_SEARCH_ENABLED = false;

export function LocalAiClientSettingsSection({
  localAiClients,
  authenticationStatus = []
}: {
  localAiClients?: DesktopApi["localAiClients"];
  authenticationStatus?: readonly {
    instanceId: string;
    authentication: "authenticated" | "unauthenticated" | "unknown";
    observedAt: string;
  }[];
}) {
  const [search, setSearch] = useState("");
  const [copiedClaudeLogin, setCopiedClaudeLogin] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const settings = useLocalAiClientSettings(localAiClients);

  if (!localAiClients) return <UnavailableSettings />;
  if (settings.loading && !settings.readModel) {
    return <LoadingSettings />;
  }
  if (!settings.readModel) {
    return (
      <p role="alert">
        {settings.refreshError ?? "AI Client settings unavailable."}
      </p>
    );
  }

  const authenticationRequired = (driverId: "claude" | "pi") =>
    settings.readModel!.instances.some((instance) => {
      if (instance.driverId !== driverId || instance.enabled === false)
        return false;
      const latest = settings
        .readModel!.capabilitySnapshots.filter(
          (snapshot) => snapshot.instanceId === instance.instanceId
        )
        .sort(
          (left, right) =>
            Date.parse(right.observedAt) - Date.parse(left.observedAt)
        )[0];
      const checked = authenticationStatus.find(
        (status) => status.instanceId === instance.instanceId
      );
      const authentication =
        checked &&
        (!latest ||
          Date.parse(checked.observedAt) >= Date.parse(latest.observedAt))
          ? checked.authentication
          : latest?.authenticationState;
      return authentication === "unauthenticated";
    });
  const claudeSignInRequired = authenticationRequired("claude");
  const piAuthenticationRequired = authenticationRequired("pi");
  const copyClaudeLogin = async () => {
    setCopiedClaudeLogin(false);
    setCopyError(null);
    try {
      const clipboard = window.koedDesktop?.clipboard;
      if (!clipboard) throw new Error("Clipboard unavailable.");
      await clipboard.writeText("claude auth login");
      setCopiedClaudeLogin(true);
    } catch (error) {
      setCopyError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="koed-local-ai-settings">
      <SettingsToolbar
        refreshing={settings.refreshing}
        refresh={settings.refresh}
        search={search}
        setSearch={(value) => {
          setSearch(value);
          settings.setSearch(value);
        }}
      />
      {claudeSignInRequired ? (
        <div className="koed-local-ai-auth-warning" role="status">
          <AlertTriangle aria-hidden="true" />
          <div>
            <strong>Claude Code sign-in required</strong>
            <p>
              Automatic capture remains available. Recall through Claude Code,
              Local Synthesis, and Managed Conversations stay unavailable until
              Claude Code is signed in. Claude Desktop sign-in does not
              authenticate Claude Code.
            </p>
          </div>
          <Button onClick={() => void copyClaudeLogin()} variant="outline">
            {copiedClaudeLogin ? (
              <Check aria-hidden="true" />
            ) : (
              <Copy aria-hidden="true" />
            )}
            {copiedClaudeLogin ? "Copied" : "Copy `claude auth login`"}
          </Button>
          <p className="koed-local-ai-auth-action">
            After signing in, refresh capabilities above. Profile reinstall is
            not required.
          </p>
          {copyError ? <p role="alert">{copyError}</p> : null}
        </div>
      ) : null}
      {piAuthenticationRequired ? (
        <div className="koed-local-ai-auth-warning" role="status">
          <AlertTriangle aria-hidden="true" />
          <div>
            <strong>Pi model authentication required</strong>
            <p>
              Automatic capture remains available. Recall and Local Synthesis
              through Pi stay unavailable until at least one model is
              authenticated through Pi.
            </p>
          </div>
          <p className="koed-local-ai-auth-action">
            After authenticating a model, refresh capabilities above. Profile
            reinstall is not required.
          </p>
        </div>
      ) : null}
      {settings.refreshError ? (
        <p className="koed-diagnostic-error" role="alert">
          Agent Configuration could not refresh its capabilities. Showing the
          last known results. {settings.refreshError}
        </p>
      ) : null}
      {flows.map((flow) => (
        <FlowSettingsFieldset
          key={flow.key}
          flow={flow}
          readModel={settings.readModel!}
          draft={
            settings.drafts[flow.key] === undefined
              ? assignmentFrom(settings.readModel!, flow.key)
              : (settings.drafts[flow.key] ?? null)
          }
          state={settings.flowStates[flow.key]}
          search={settings.deferredSearch}
          updateDraft={settings.updateDraft}
          save={settings.save}
          reset={settings.reset}
        />
      ))}
    </div>
  );
}

const SettingsToolbar = ({
  refreshing,
  refresh,
  search,
  setSearch
}: {
  refreshing: boolean;
  refresh: () => Promise<void>;
  search: string;
  setSearch: (value: string) => void;
}) => (
  <>
    <div className="koed-local-ai-toolbar">
      <h2>Agent Configuration</h2>
      <Button
        aria-busy={refreshing}
        aria-label={
          refreshing ? "Refreshing capabilities" : "Refresh capabilities"
        }
        disabled={refreshing}
        onClick={() => void refresh()}
        size="icon"
        title={refreshing ? "Refreshing capabilities" : "Refresh capabilities"}
        variant="outline"
      >
        <RefreshCw aria-hidden="true" />
      </Button>
    </div>
    {AGENT_SEARCH_ENABLED ? (
      <label className="koed-local-ai-search">
        Search client, provider, display name, model, or full model ID
        <Input
          aria-label="Search local AI Clients and models"
          onChange={(event) => setSearch(event.currentTarget.value)}
          placeholder="Search AI Clients and models"
          type="search"
          value={search}
        />
      </label>
    ) : null}
  </>
);

const LoadingSettings = () => (
  <div
    aria-busy="true"
    aria-label="Loading AI Client settings"
    className="koed-local-ai-settings-loading"
    role="status"
  >
    <Spinner aria-hidden="true" />
    <div>
      <strong>Loading AI Client settings</strong>
      <p>Checking configured agents and available models…</p>
    </div>
  </div>
);

const UnavailableSettings = () => (
  <div className="koed-preference-unavailable" role="status">
    <AlertTriangle aria-hidden="true" />
    <div>
      <strong>Local AI Client settings unavailable</strong>
      <p>Trusted Desktop IPC did not provide local runtime settings.</p>
    </div>
  </div>
);
