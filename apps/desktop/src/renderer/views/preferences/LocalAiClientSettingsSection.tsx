import { AlertTriangle, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Button, Input } from "@koed/ui";
import type { DesktopApi } from "../../../types.js";
import { FlowSettingsFieldset } from "./FlowSettingsFieldset.js";
import { assignmentFrom, flows } from "./local-ai-client-settings-helpers.js";
import { useLocalAiClientSettings } from "./useLocalAiClientSettings.js";

export function LocalAiClientSettingsSection({
  localAiClients
}: {
  localAiClients?: DesktopApi["localAiClients"];
}) {
  const [search, setSearch] = useState("");
  const settings = useLocalAiClientSettings(localAiClients);

  if (!localAiClients) return <UnavailableSettings />;
  if (settings.loading && !settings.readModel) {
    return <p role="status">Opening saved AI Client settings…</p>;
  }
  if (!settings.readModel) {
    return (
      <p role="alert">
        {settings.refreshError ?? "AI Client settings unavailable."}
      </p>
    );
  }

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
      {settings.refreshError ? (
        <p className="koed-diagnostic-error" role="alert">
          {settings.refreshError}
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
      <div>
        <h2>Local AI Client flows</h2>
        <p>
          Each flow persists independently. Unavailable assignments stay visible
          and block only their flow.
        </p>
      </div>
      <Button
        disabled={refreshing}
        onClick={() => void refresh()}
        variant="outline"
      >
        <RefreshCw aria-hidden="true" />{" "}
        {refreshing ? "Refreshing…" : "Refresh capabilities"}
      </Button>
    </div>
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
  </>
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
