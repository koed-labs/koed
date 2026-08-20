import { useDeferredValue, useState } from "react";
import type { LocalAiClientFlowKey } from "../../../ipc/local-ai-client-protocol.js";
import type { DesktopApi } from "../../../types.js";
import type {
  Draft,
  FlowState,
  ReadModel
} from "./local-ai-client-settings-helpers.js";
import { useLocalAiClientSettingsState } from "./local-ai-client-settings-state.js";

type LocalAiClients = DesktopApi["localAiClients"];

type SettingsController = {
  readModel: ReadModel | null;
  drafts: Partial<Record<LocalAiClientFlowKey, Draft | null>>;
  flowStates: Record<LocalAiClientFlowKey, FlowState>;
  loading: boolean;
  refreshing: boolean;
  refreshError: string | null;
  deferredSearch: string;
  setSearch: (value: string) => void;
  refresh: () => Promise<void>;
  updateDraft: (flowKey: LocalAiClientFlowKey, draft: Draft) => void;
  save: (
    flowKey: LocalAiClientFlowKey,
    draft: Draft,
    available: boolean,
    label: string
  ) => Promise<void>;
  reset: (flowKey: LocalAiClientFlowKey, label: string) => Promise<void>;
};

export const useLocalAiClientSettings = (
  localAiClients: LocalAiClients
): SettingsController => {
  const [search, setSearch] = useState("");
  const settings = useLocalAiClientSettingsState(localAiClients);
  return {
    ...settings,
    deferredSearch: useDeferredValue(search.trim().toLowerCase()),
    setSearch
  };
};
