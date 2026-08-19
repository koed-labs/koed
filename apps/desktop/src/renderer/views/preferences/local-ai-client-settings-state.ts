import { useEffect, useRef, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type {
  LocalAiClientFlowKey,
  LocalAiClientResponse
} from "../../../ipc/local-ai-client-protocol.js";
import type { DesktopApi } from "../../../types.js";
import {
  assignmentFrom,
  emptyFlowStates,
  flows,
  type Draft,
  type FlowState,
  type ReadModel
} from "./local-ai-client-settings-helpers.js";

type LocalAiClients = NonNullable<DesktopApi["localAiClients"]>;
type ApplyResponse = (
  response: LocalAiClientResponse,
  generation: number
) => void;
type ResponseState = {
  readModel: ReadModel | null;
  drafts: Partial<Record<LocalAiClientFlowKey, Draft | null>>;
  loading: boolean;
  refreshing: boolean;
  refreshError: string | null;
  setReadModel: Dispatch<SetStateAction<ReadModel | null>>;
  setDrafts: Dispatch<
    SetStateAction<Partial<Record<LocalAiClientFlowKey, Draft | null>>>
  >;
  setLoading: Dispatch<SetStateAction<boolean>>;
  setRefreshing: Dispatch<SetStateAction<boolean>>;
  setRefreshError: Dispatch<SetStateAction<string | null>>;
};

const useResponseState = (): ResponseState => {
  const [readModel, setReadModel] = useState<ReadModel | null>(null);
  const [drafts, setDrafts] = useState<
    Partial<Record<LocalAiClientFlowKey, Draft | null>>
  >({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  return {
    readModel,
    drafts,
    loading,
    refreshing,
    refreshError,
    setReadModel,
    setDrafts,
    setLoading,
    setRefreshing,
    setRefreshError
  };
};

const applyResponse = (
  response: LocalAiClientResponse,
  generation: number,
  currentGeneration: number,
  state: ResponseState
) => {
  if (generation < currentGeneration) return;
  state.setReadModel(response.readModel);
  state.setDrafts((current) => {
    const next = { ...current };
    for (const { key } of flows) {
      if (!(key in next)) next[key] = assignmentFrom(response.readModel, key);
    }
    return next;
  });
  if (response.refreshError !== undefined)
    state.setRefreshError(response.refreshError);
};

const loadInitialSettings = async (input: {
  clients: LocalAiClients;
  active: () => boolean;
  listGeneration: number;
  allocateGeneration: () => number;
  apply: ApplyResponse;
  state: ResponseState;
}) => {
  try {
    const response = await input.clients.list();
    if (!input.active()) return;
    input.apply(response, input.listGeneration);
    input.state.setLoading(false);
    input.state.setRefreshing(true);
    const refreshGeneration = input.allocateGeneration();
    const refreshResponse = await input.clients.refresh();
    if (input.active()) input.apply(refreshResponse, refreshGeneration);
  } catch (cause) {
    if (!input.active()) return;
    input.state.setLoading(false);
    input.state.setRefreshing(false);
    input.state.setRefreshError(
      cause instanceof Error ? cause.message : "AI Client settings unavailable."
    );
  } finally {
    if (input.active()) input.state.setRefreshing(false);
  }
};

const useResponseLifecycle = (
  localAiClients: LocalAiClients | undefined,
  state: ResponseState,
  apply: ApplyResponse,
  allocateGeneration: () => number
) => {
  useEffect(() => {
    let active = true;
    if (!localAiClients) {
      state.setLoading(false);
      return () => {
        active = false;
      };
    }
    void loadInitialSettings({
      clients: localAiClients,
      active: () => active,
      listGeneration: allocateGeneration(),
      allocateGeneration,
      apply,
      state
    });
    return () => {
      active = false;
    };
  }, [localAiClients]);
};

const useLocalAiClientResponses = (localAiClients?: LocalAiClients) => {
  const state = useResponseState();
  const responseGeneration = useRef(0);
  const allocateGeneration = () => ++responseGeneration.current;
  const apply = (response: LocalAiClientResponse, generation: number) =>
    applyResponse(response, generation, responseGeneration.current, state);
  useResponseLifecycle(localAiClients, state, apply, allocateGeneration);

  const refresh = async () => {
    if (!localAiClients || state.refreshing) return;
    state.setRefreshing(true);
    state.setRefreshError(null);
    const generation = allocateGeneration();
    try {
      apply(await localAiClients.refresh(), generation);
    } catch (cause) {
      state.setRefreshError(
        cause instanceof Error ? cause.message : "Capability refresh failed."
      );
    } finally {
      state.setRefreshing(false);
    }
  };
  return { ...state, apply, allocateGeneration, refresh };
};

type MutationState = {
  flowStates: Record<LocalAiClientFlowKey, FlowState>;
  setFlowStates: Dispatch<
    SetStateAction<Record<LocalAiClientFlowKey, FlowState>>
  >;
  inFlight: MutableRefObject<Set<LocalAiClientFlowKey>>;
  flowGenerations: MutableRefObject<Record<LocalAiClientFlowKey, number>>;
};

const useMutationState = (): MutationState => {
  const [flowStates, setFlowStates] = useState(emptyFlowStates);
  const inFlight = useRef(new Set<LocalAiClientFlowKey>());
  const flowGenerations = useRef<Record<LocalAiClientFlowKey, number>>(
    Object.fromEntries(flows.map(({ key }) => [key, 0])) as Record<
      LocalAiClientFlowKey,
      number
    >
  );
  return { flowStates, setFlowStates, inFlight, flowGenerations };
};

const beginMutation = (
  flowKey: LocalAiClientFlowKey,
  state: MutationState,
  allocateGeneration: () => number
): number | null => {
  if (state.inFlight.current.has(flowKey)) return null;
  state.inFlight.current.add(flowKey);
  state.flowGenerations.current[flowKey] += 1;
  state.setFlowStates((current) => ({
    ...current,
    [flowKey]: { ...current[flowKey], pending: true, error: null }
  }));
  return allocateGeneration();
};

const finishMutation = (
  flowKey: LocalAiClientFlowKey,
  state: MutationState
) => {
  state.inFlight.current.delete(flowKey);
  state.setFlowStates((current) => ({
    ...current,
    [flowKey]: { ...current[flowKey], pending: false }
  }));
};

const setMutationError = (
  flowKey: LocalAiClientFlowKey,
  label: string,
  cause: unknown,
  state: MutationState
) => {
  state.setFlowStates((current) => ({
    ...current,
    [flowKey]: {
      ...current[flowKey],
      error: cause instanceof Error ? cause.message : `Could not ${label}.`
    }
  }));
};

const mutateFlow = async (input: {
  flowKey: LocalAiClientFlowKey;
  label: string;
  operation: () => Promise<LocalAiClientResponse>;
  state: MutationState;
  apply: ApplyResponse;
  allocateGeneration: () => number;
  onSuccess: (response: LocalAiClientResponse) => void;
}) => {
  const generation = beginMutation(
    input.flowKey,
    input.state,
    input.allocateGeneration
  );
  if (generation === null) return;
  const flowGeneration = input.state.flowGenerations.current[input.flowKey];
  try {
    const response = await input.operation();
    if (flowGeneration !== input.state.flowGenerations.current[input.flowKey])
      return;
    input.apply(response, generation);
    input.onSuccess(response);
  } catch (cause) {
    if (flowGeneration === input.state.flowGenerations.current[input.flowKey])
      setMutationError(input.flowKey, input.label, cause, input.state);
  } finally {
    finishMutation(input.flowKey, input.state);
  }
};

type MutationDependencies = {
  localAiClients: LocalAiClients | undefined;
  setDrafts: ResponseState["setDrafts"];
  apply: ApplyResponse;
  allocateGeneration: () => number;
  state: MutationState;
};

const saveFlow = async (
  flowKey: LocalAiClientFlowKey,
  draft: Draft,
  available: boolean,
  label: string,
  input: MutationDependencies
) => {
  const clients = input.localAiClients;
  if (!clients || !available) return;
  await mutateFlow({
    flowKey,
    label: `save ${label}`,
    operation: () => clients.set(flowKey, draft),
    state: input.state,
    apply: input.apply,
    allocateGeneration: input.allocateGeneration,
    onSuccess: () =>
      input.state.setFlowStates((current) => ({
        ...current,
        [flowKey]: {
          ...current[flowKey],
          dirty: false,
          saved: true,
          error: null
        }
      }))
  });
};

const resetFlow = async (
  flowKey: LocalAiClientFlowKey,
  label: string,
  input: MutationDependencies
) => {
  const clients = input.localAiClients;
  if (!clients) return;
  await mutateFlow({
    flowKey,
    label: `reset ${label}`,
    operation: () => clients.reset(flowKey),
    state: input.state,
    apply: input.apply,
    allocateGeneration: input.allocateGeneration,
    onSuccess: (response) => {
      input.setDrafts((current) => ({
        ...current,
        [flowKey]: assignmentFrom(response.readModel, flowKey)
      }));
      input.state.setFlowStates((current) => ({
        ...current,
        [flowKey]: {
          ...current[flowKey],
          dirty: false,
          saved: false,
          error: null
        }
      }));
    }
  });
};

const useLocalAiClientMutations = (
  input: Omit<MutationDependencies, "state">
) => {
  const state = useMutationState();
  const dependencies = { ...input, state };
  const updateDraft = (flowKey: LocalAiClientFlowKey, draft: Draft) => {
    input.setDrafts((current) => ({ ...current, [flowKey]: draft }));
    state.setFlowStates((current) => ({
      ...current,
      [flowKey]: { ...current[flowKey], dirty: true, saved: false, error: null }
    }));
  };
  const save = (
    flowKey: LocalAiClientFlowKey,
    draft: Draft,
    available: boolean,
    label: string
  ) => saveFlow(flowKey, draft, available, label, dependencies);
  const reset = (flowKey: LocalAiClientFlowKey, label: string) =>
    resetFlow(flowKey, label, dependencies);
  return { flowStates: state.flowStates, updateDraft, save, reset };
};

export const useLocalAiClientSettingsState = (
  localAiClients: LocalAiClients | undefined
) => {
  const responses = useLocalAiClientResponses(localAiClients);
  const mutations = useLocalAiClientMutations({
    localAiClients,
    setDrafts: responses.setDrafts,
    apply: responses.apply,
    allocateGeneration: responses.allocateGeneration
  });
  return { ...responses, ...mutations };
};
