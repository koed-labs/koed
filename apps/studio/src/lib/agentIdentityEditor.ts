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
