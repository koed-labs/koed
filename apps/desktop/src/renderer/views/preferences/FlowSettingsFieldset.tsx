import type { LocalAiClientFlowKey } from "../../../ipc/local-ai-client-protocol.js";
import { Button } from "@koed/ui";
import type {
  Draft,
  Flow,
  FlowState,
  ReadModel
} from "./local-ai-client-settings-helpers.js";
import {
  assignmentStatusFor,
  modelId,
  modelLabel,
  modelMatches,
  optionValue,
  searchableInstance,
  searchableModelText,
  snapshotFor,
  statusFor
} from "./local-ai-client-settings-helpers.js";

type Props = {
  flow: Flow;
  readModel: ReadModel;
  draft: Draft | null;
  state: FlowState;
  search: string;
  updateDraft: (flowKey: LocalAiClientFlowKey, draft: Draft) => void;
  save: (
    flowKey: LocalAiClientFlowKey,
    draft: Draft,
    available: boolean,
    label: string
  ) => Promise<void>;
  reset: (flowKey: LocalAiClientFlowKey, label: string) => Promise<void>;
};

type FlowViewModel = {
  defaultInfo: ReadModel["defaults"][LocalAiClientFlowKey];
  instance: ReadModel["instances"][number] | undefined;
  models: ReadModel["capabilitySnapshots"][number]["models"];
  selectedModel:
    | ReadModel["capabilitySnapshots"][number]["models"][number]
    | undefined;
  status: ReturnType<typeof assignmentStatusFor>;
  instanceOptions: ReadModel["instances"];
  modelOptions: ReadModel["capabilitySnapshots"][number]["models"];
  efforts: string[];
  hasSetting: boolean;
};

export function FlowSettingsFieldset(props: Props) {
  const { draft, ...rest } = props;
  const defaultInfo = props.readModel.defaults[props.flow.key];
  if (!draft)
    return <UnavailableFlow flow={props.flow} reason={defaultInfo.reason} />;
  const viewModel = buildFlowViewModel(
    props.readModel,
    props.flow,
    draft,
    props.search
  );
  return <FlowFieldset {...rest} draft={draft} viewModel={viewModel} />;
}

type FlowFieldsetProps = Omit<Props, "draft"> & {
  draft: Draft;
  viewModel: FlowViewModel;
};

const FlowFieldset = ({
  flow,
  draft,
  state,
  save,
  reset,
  viewModel,
  ...inputProps
}: FlowFieldsetProps) => (
  <fieldset className="koed-local-ai-flow">
    <legend>{flow.label}</legend>
    <FlowDiagnostics
      flow={flow}
      defaultInfo={viewModel.defaultInfo}
      hasSetting={viewModel.hasSetting}
      state={state}
      status={viewModel.status}
    />
    <FlowInputs
      {...inputProps}
      draft={draft}
      flow={flow}
      state={state}
      viewModel={viewModel}
    />
    <FlowActions
      draft={draft}
      flow={flow}
      hasSetting={viewModel.hasSetting}
      state={state}
      status={viewModel.status}
      save={save}
      reset={reset}
    />
    <FlowExecutionDiagnostic status={viewModel.status} />
  </fieldset>
);

type FlowInputsProps = Pick<
  FlowFieldsetProps,
  "flow" | "readModel" | "draft" | "state" | "updateDraft" | "viewModel"
>;

const FlowInputs = ({
  flow,
  readModel,
  draft,
  state,
  updateDraft,
  viewModel
}: FlowInputsProps) => (
  <>
    <InstanceSelect
      flow={flow}
      draft={draft}
      options={viewModel.instanceOptions}
      readModel={readModel}
      state={state}
      status={viewModel.status}
      onChange={(instanceId) =>
        updateInstanceDraft(readModel, flow, draft, instanceId, updateDraft)
      }
    />
    <ModelSelect
      draft={draft}
      flow={flow}
      options={viewModel.modelOptions}
      state={state}
      status={viewModel.status}
      onChange={(model) =>
        updateModelDraft(viewModel.models, flow, draft, model, updateDraft)
      }
    />
    <ReasoningSelect
      draft={draft}
      flow={flow}
      efforts={viewModel.efforts}
      state={state}
      status={viewModel.status}
      onChange={(reasoning_effort) =>
        updateDraft(flow.key, { ...draft, reasoning_effort })
      }
    />
  </>
);

const buildFlowViewModel = (
  readModel: ReadModel,
  flow: Flow,
  draft: Draft,
  search: string
): FlowViewModel => {
  const instance = readModel.instances.find(
    (candidate) => candidate.instanceId === draft.ai_client_instance_id
  );
  const snapshot = snapshotFor(readModel, draft.ai_client_instance_id);
  const models = snapshot?.models ?? [];
  const selectedModel = models.find((model) =>
    modelMatches(model, draft.model)
  );
  return {
    defaultInfo: readModel.defaults[flow.key],
    instance,
    models,
    selectedModel,
    status: assignmentStatusFor(readModel, draft, selectedModel),
    instanceOptions: filteredInstances(readModel, search, instance),
    modelOptions: filteredModels(models, search, draft.model),
    efforts: selectedModel?.reasoningEfforts ?? [],
    hasSetting: readModel.settings.some(
      (setting) => setting.flowKey === flow.key
    )
  };
};

const updateInstanceDraft = (
  readModel: ReadModel,
  flow: Flow,
  draft: Draft,
  instanceId: string,
  updateDraft: Props["updateDraft"]
) => {
  const nextInstance = readModel.instances.find(
    (candidate) => candidate.instanceId === instanceId
  );
  const nextModel = snapshotFor(readModel, instanceId)?.models[0];
  updateDraft(flow.key, {
    ...draft,
    provider: nextInstance?.driverId ?? draft.provider,
    ai_client_instance_id: instanceId,
    model: nextModel ? modelId(nextModel) : draft.model,
    reasoning_effort: nextModel?.reasoningEfforts[0] ?? "none"
  });
};

const updateModelDraft = (
  models: FlowViewModel["models"],
  flow: Flow,
  draft: Draft,
  model: string,
  updateDraft: Props["updateDraft"]
) => {
  const nextModel = models.find((candidate) => modelId(candidate) === model);
  updateDraft(flow.key, {
    ...draft,
    model,
    reasoning_effort: nextModel?.reasoningEfforts[0] ?? "none"
  });
};

type SelectProps = {
  flow: Flow;
  draft: Draft;
  state: FlowState;
  status: ReturnType<typeof assignmentStatusFor>;
};

const InstanceSelect = ({
  flow,
  draft,
  options,
  readModel,
  state,
  status,
  onChange
}: SelectProps & {
  options: ReadModel["instances"];
  readModel: ReadModel;
  onChange: (instanceId: string) => void;
}) => (
  <label>
    Agent
    <select
      aria-describedby={`${flow.key}-status`}
      aria-invalid={!status.available}
      aria-label={`${flow.label} Agent`}
      disabled={state.pending}
      onChange={(event) => onChange(event.currentTarget.value)}
      value={
        readModel.instances.find(
          (candidate) => candidate.instanceId === draft.ai_client_instance_id
        )?.instanceId ?? draft.ai_client_instance_id
      }
    >
      {!readModel.instances.some(
        (candidate) => candidate.instanceId === draft.ai_client_instance_id
      ) ? (
        <option value={draft.ai_client_instance_id}>
          {draft.ai_client_instance_id} — Unavailable
        </option>
      ) : null}
      {options.map((candidate) => (
        <option key={candidate.instanceId} value={candidate.instanceId}>
          {instanceOptionLabel(readModel, candidate)}
        </option>
      ))}
    </select>
  </label>
);

const ModelSelect = ({
  flow,
  draft,
  options,
  state,
  status,
  onChange
}: SelectProps & {
  options: ReadModel["capabilitySnapshots"][number]["models"];
  onChange: (model: string) => void;
}) => (
  <label>
    Model
    <select
      aria-describedby={`${flow.key}-status`}
      aria-invalid={!status.available}
      aria-label={`${flow.label} model`}
      disabled={state.pending}
      onChange={(event) =>
        onChange(event.currentTarget.value.split("\u0000")[1] ?? "")
      }
      value={optionValue(draft.ai_client_instance_id, draft.model)}
    >
      {options.map((model) => (
        <option
          key={modelId(model)}
          value={optionValue(draft.ai_client_instance_id, modelId(model))}
        >
          {modelLabel(model)}
        </option>
      ))}
    </select>
  </label>
);

const ReasoningSelect = ({
  flow,
  draft,
  efforts,
  state,
  status,
  onChange
}: SelectProps & {
  efforts: string[];
  onChange: (effort: string) => void;
}) => (
  <label>
    Reasoning effort
    <select
      aria-describedby={`${flow.key}-status`}
      aria-invalid={!status.available}
      aria-label={`${flow.label} reasoning effort`}
      disabled={efforts.length === 0 || state.pending}
      onChange={(event) => onChange(event.currentTarget.value)}
      value={draft.reasoning_effort}
    >
      {efforts.length === 0 ? (
        <option value="none">Not supported by selected model</option>
      ) : null}
      {efforts.map((effort) => (
        <option key={effort} value={effort}>
          {capitalizeOptionLabel(effort)}
        </option>
      ))}
    </select>
  </label>
);

const FlowActions = ({
  draft,
  flow,
  hasSetting,
  state,
  status,
  save,
  reset
}: SelectProps & {
  hasSetting: boolean;
  save: Props["save"];
  reset: Props["reset"];
}) => (
  <div className="koed-local-ai-actions">
    <Button
      disabled={state.pending || !status.available || !state.dirty}
      onClick={() => void save(flow.key, draft, status.available, flow.label)}
      type="button"
    >
      {state.pending ? "Working…" : "Save"}
    </Button>
    <Button
      disabled={state.pending || !hasSetting}
      onClick={() => void reset(flow.key, flow.label)}
      type="button"
      variant="outline"
    >
      Reset
    </Button>
    {state.saved && !state.dirty ? <span role="status">Saved</span> : null}
  </div>
);

const FlowDiagnostics = ({
  flow,
  defaultInfo,
  hasSetting,
  state,
  status
}: {
  flow: Flow;
  defaultInfo: ReadModel["defaults"][LocalAiClientFlowKey];
  hasSetting: boolean;
  state: FlowState;
  status: ReturnType<typeof assignmentStatusFor>;
}) => (
  <>
    <p className="koed-local-ai-flow-description">{flow.description}</p>
    {!hasSetting && status.available ? (
      <span className="koed-visually-hidden" id={`${flow.key}-status`}>
        Ready
      </span>
    ) : (
      <p
        className="koed-local-ai-flow-status"
        data-ready={status.available}
        id={`${flow.key}-status`}
        role="status"
      >
        {hasSetting ? "Saved assignment" : "Default assignment"} · {status.text}
      </p>
    )}
    {!hasSetting && defaultInfo.persistable === false ? (
      <p className="koed-local-ai-diagnostic" role="status">
        Runtime default cannot be persisted: {defaultInfo.reason}
      </p>
    ) : null}
    {state.error ? (
      <p className="koed-diagnostic-error" role="alert">
        {state.error}
      </p>
    ) : null}
  </>
);

const FlowExecutionDiagnostic = ({
  status
}: {
  status: ReturnType<typeof assignmentStatusFor>;
}) =>
  !status.available ? (
    <p aria-live="polite" className="koed-local-ai-diagnostic" role="status">
      Cannot execute: {status.text}. Select healthy, authenticated instance and
      model with explicitly reported reasoning support, or reset assignment.
    </p>
  ) : null;

const filteredInstances = (
  readModel: ReadModel,
  search: string,
  current: ReadModel["instances"][number] | undefined
) => {
  const options = readModel.instances.filter(
    (candidate) =>
      !search ||
      searchableInstance(
        candidate,
        snapshotFor(readModel, candidate.instanceId)
      ).includes(search)
  );
  if (
    current &&
    !options.some((candidate) => candidate.instanceId === current.instanceId)
  )
    options.unshift(current);
  return options;
};

const instanceOptionLabel = (
  readModel: ReadModel,
  instance: ReadModel["instances"][number]
): string => {
  const status = statusFor(readModel, instance.instanceId);
  return status.available
    ? instance.displayName
    : `${instance.displayName} — ${capitalizeOptionLabel(status.text)}`;
};

const capitalizeOptionLabel = (value: string): string =>
  value.length === 0 ? value : `${value[0]!.toUpperCase()}${value.slice(1)}`;

const filteredModels = (
  models: ReadModel["capabilitySnapshots"][number]["models"],
  search: string,
  currentModel: string
) => {
  const options = models.filter(
    (model) => !search || searchableModelText(model).includes(search)
  );
  if (!options.some((model) => modelId(model) === currentModel)) {
    options.unshift({
      id: currentModel,
      displayName: null,
      provider: null,
      model: null,
      fullId: currentModel,
      reasoningEfforts: []
    });
  }
  return options;
};

const UnavailableFlow = ({
  flow,
  reason
}: {
  flow: Flow;
  reason: string | null;
}) => (
  <fieldset className="koed-local-ai-flow" key={flow.key}>
    <legend>{flow.label}</legend>
    <p className="koed-local-ai-flow-status" role="status">
      Unavailable · {reason ?? "No valid default assignment."}
    </p>
    <p className="koed-local-ai-diagnostic" role="status">
      Cannot execute: missing valid flow default. Configure complete provider
      and model values.
    </p>
  </fieldset>
);
