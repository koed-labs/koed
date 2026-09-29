import {
  generateAgentIdentity,
  type AgentAvatar,
  type AgentDefinition
} from "./collab";

export type AgentModelCapability = Readonly<{
  provider: string;
  instanceId?: string;
  id: string;
  displayName?: string;
  supportedReasoningEfforts: readonly string[];
}>;

export type AgentModelOption = Readonly<{
  id: string;
  label: string;
  available: boolean;
}>;

export type AgentIdentityEditorValues = Readonly<{
  name: string;
  role: string;
  soul: string;
  avatar?: AgentAvatar;
  preferredModel: string | null;
  preferredEffort: string | null;
  sourceTemplateId: string | null;
  sourceTemplateVersion: number | null;
}>;

export type AgentIdentityEditorInitialValues =
  Partial<AgentIdentityEditorValues>;

export type AgentIdentityDraftStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

export type AgentIdentityDraftScope = Readonly<{
  ownerId: string;
  backendId: string;
}>;

export type AgentIdentityDraftBridge = Readonly<{
  read: (input: {
    ownerId: string;
    executionId: string;
  }) => Promise<string | null>;
  write: (input: {
    ownerId: string;
    executionId: string;
    value: string;
  }) => Promise<void>;
  delete: (input: { ownerId: string; executionId: string }) => Promise<void>;
}>;

export type AgentIdentityDraftStore = Readonly<{
  hydrate: () => Promise<AgentIdentityEditorValues | null>;
  write: (values: AgentIdentityEditorValues) => Promise<void>;
  clear: () => Promise<void>;
}>;

type AgentIdentityDraftStoreOptions = Readonly<{
  scope: AgentIdentityDraftScope;
  target: string;
  storage?: AgentIdentityDraftStorage;
  bridge?: AgentIdentityDraftBridge | null;
}>;

const AGENT_DRAFT_VERSION = 1;
const MAX_AGENT_DRAFT_LENGTH = 64_000;

export type AgentIdentityEditorOptions = Readonly<{
  definition?: AgentDefinition;
  initialValues?: AgentIdentityEditorInitialValues;
}>;

export function generatedSoul(name: string, role: string): string {
  return generateAgentIdentity({
    name: name.trim() || "this agent",
    role: role.trim() || "teammate"
  });
}

export function initialAgentIdentityEditorValues({
  definition,
  initialValues
}: AgentIdentityEditorOptions = {}): AgentIdentityEditorValues {
  const name = initialValues?.name ?? definition?.name ?? "";
  const role = initialValues?.role ?? definition?.role ?? "";
  return {
    name,
    role,
    // Existing definitions are authoritative. New definitions get a generated
    // draft that the editor may replace without future name/role regeneration.
    soul:
      initialValues?.soul ?? definition?.identity ?? generatedSoul(name, role),
    avatar: initialValues?.avatar ?? definition?.avatar,
    preferredModel: initialValues?.preferredModel ?? null,
    preferredEffort: initialValues?.preferredEffort ?? null,
    sourceTemplateId: initialValues?.sourceTemplateId ?? null,
    sourceTemplateVersion: initialValues?.sourceTemplateVersion ?? null
  };
}

export function modelLabel(capability: AgentModelCapability): string {
  return capability.displayName?.trim() || capability.id;
}

export function modelOptionId(capability: AgentModelCapability): string {
  return `${capability.provider}:${capability.id}`;
}

export function modelOptions(
  capabilities: readonly AgentModelCapability[],
  selectedModel: string | null
): AgentModelOption[] {
  const options = capabilities.map((capability) => ({
    id: modelOptionId(capability),
    label: modelLabel(capability),
    available: true
  }));
  if (selectedModel && !options.some((option) => option.id === selectedModel)) {
    options.unshift({
      id: selectedModel,
      label: selectedModel,
      available: false
    });
  }
  return options;
}

export function canSubmitAgentIdentity(
  values: Pick<AgentIdentityEditorValues, "name" | "role" | "soul">
): boolean {
  return Boolean(
    values.name.trim() && values.role.trim() && values.soul.trim()
  );
}

export function capabilitiesForModel(
  capabilities: readonly AgentModelCapability[],
  model: string | null
): AgentModelCapability | null {
  if (!model) return null;
  return (
    capabilities.find((capability) => modelOptionId(capability) === model) ??
    null
  );
}

export function effortsForModel(
  capabilities: readonly AgentModelCapability[],
  model: string | null
): string[] {
  return [
    ...(capabilitiesForModel(capabilities, model)?.supportedReasoningEfforts ??
      [])
  ];
}

export function preferredEffortForModel(
  capabilities: readonly AgentModelCapability[],
  model: string | null,
  effort: string | null
): string | null {
  const efforts = effortsForModel(capabilities, model);
  return effort && efforts.includes(effort) ? effort : (efforts[0] ?? null);
}

export function soulAfterNameOrRoleChange(
  soul: string,
  previousSoul: string,
  nextName: string,
  nextRole: string
): string {
  return soul === previousSoul ? generatedSoul(nextName, nextRole) : soul;
}

export function readAgentIdentityDraft(
  storage: AgentIdentityDraftStorage,
  key: string
): AgentIdentityEditorValues | null {
  try {
    return parseAgentIdentityDraft(storage.getItem(key));
  } catch {
    return null;
  }
}

export function parseAgentIdentityDraft(
  raw: string | null
): AgentIdentityEditorValues | null {
  try {
    if (!raw || raw.length > MAX_AGENT_DRAFT_LENGTH) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    const values = record.values;
    if (
      record.version !== AGENT_DRAFT_VERSION ||
      !values ||
      typeof values !== "object"
    )
      return null;
    const valueRecord = values as Record<string, unknown>;
    if (
      typeof valueRecord.name !== "string" ||
      typeof valueRecord.role !== "string" ||
      typeof valueRecord.soul !== "string" ||
      !(
        valueRecord.preferredModel === null ||
        typeof valueRecord.preferredModel === "string"
      ) ||
      !(
        valueRecord.preferredEffort === null ||
        typeof valueRecord.preferredEffort === "string"
      ) ||
      !(
        valueRecord.sourceTemplateId === null ||
        typeof valueRecord.sourceTemplateId === "string"
      ) ||
      !(
        valueRecord.sourceTemplateVersion === null ||
        typeof valueRecord.sourceTemplateVersion === "number"
      )
    )
      return null;
    return {
      name: valueRecord.name,
      role: valueRecord.role,
      soul: valueRecord.soul,
      avatar: valueRecord.avatar as AgentAvatar | undefined,
      preferredModel: valueRecord.preferredModel,
      preferredEffort: valueRecord.preferredEffort,
      sourceTemplateId: valueRecord.sourceTemplateId,
      sourceTemplateVersion: valueRecord.sourceTemplateVersion
    };
  } catch {
    return null;
  }
}

export function serializeAgentIdentityDraft(
  values: AgentIdentityEditorValues
): string {
  const serialized = JSON.stringify({ version: AGENT_DRAFT_VERSION, values });
  if (serialized.length > MAX_AGENT_DRAFT_LENGTH) {
    throw new Error("This agent draft is too large for device storage.");
  }
  return serialized;
}

export function writeAgentIdentityDraft(
  storage: AgentIdentityDraftStorage,
  key: string,
  values: AgentIdentityEditorValues
): void {
  storage.setItem(key, serializeAgentIdentityDraft(values));
}

export function clearAgentIdentityDraft(
  storage: AgentIdentityDraftStorage,
  key: string
): void {
  storage.removeItem(key);
}

function desktopAgentDraftBridge(): AgentIdentityDraftBridge | null {
  if (typeof window === "undefined") return null;
  return (
    (
      window as unknown as {
        koedStudioChatRecovery?: AgentIdentityDraftBridge;
      }
    ).koedStudioChatRecovery ?? null
  );
}

function agentIdentityDraftStorageKey(
  scope: AgentIdentityDraftScope,
  target: string
): string {
  const part = (value: string) => encodeURIComponent(value.trim());
  return `koed.studio.personal-agent-draft.v1:${part(scope.backendId)}:${part(scope.ownerId)}:${part(target)}`;
}

export function createAgentIdentityDraftStore({
  scope,
  target,
  storage,
  bridge
}: AgentIdentityDraftStoreOptions): AgentIdentityDraftStore | null {
  const ownerId = scope.ownerId.trim();
  const backendId = scope.backendId.trim();
  const normalizedTarget = target.trim();
  if (!ownerId || !backendId || !normalizedTarget) return null;
  const executionId = `agent-draft:${normalizedTarget}`;
  if (executionId.length > 512) return null;
  const desktop = bridge === undefined ? desktopAgentDraftBridge() : bridge;
  let localStorage = storage;
  if (!desktop && !localStorage && typeof window !== "undefined") {
    try {
      localStorage = window.localStorage;
    } catch {
      return null;
    }
  }
  if (!desktop && !localStorage) return null;

  const key = agentIdentityDraftStorageKey(
    { ownerId, backendId },
    normalizedTarget
  );
  let queue: Promise<void> = Promise.resolve();
  const enqueue = <T>(action: () => Promise<T>): Promise<T> => {
    const result = queue.catch(() => undefined).then(action);
    queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };
  const identity = { ownerId, executionId };

  if (desktop) {
    return {
      hydrate: () =>
        enqueue(async () => {
          return parseAgentIdentityDraft(await desktop.read(identity));
        }),
      write: (values) => {
        const serialized = serializeAgentIdentityDraft(values);
        return enqueue(() => desktop.write({ ...identity, value: serialized }));
      },
      clear: () => {
        return enqueue(() => desktop.delete(identity));
      }
    };
  }

  return {
    hydrate: () =>
      enqueue(async () => {
        return readAgentIdentityDraft(localStorage!, key);
      }),
    write: (values) => {
      const serialized = serializeAgentIdentityDraft(values);
      return enqueue(async () => {
        localStorage!.setItem(key, serialized);
      });
    },
    clear: () => {
      return enqueue(async () => {
        localStorage!.removeItem(key);
      });
    }
  };
}
