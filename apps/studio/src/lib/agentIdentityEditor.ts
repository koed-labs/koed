import type { AgentAvatar, AgentDefinition } from "./collab";

/** Runtime capabilities belong to a chat execution, never an Agent profile. */
export type AgentModelCapability = Readonly<{
  provider: string;
  instanceId?: string;
  hostedInstanceId?: string;
  targetDeviceId?: string;
  computerLabel?: string;
  id: string;
  displayName?: string;
  supportedReasoningEfforts: readonly string[];
}>;

/** The editable, reusable part of an Agent profile. */
export type AgentIdentityEditorValues = Readonly<{
  name: string;
  role: string;
  avatar?: AgentAvatar;
}>;

export type AgentIdentityEditorInitialValues =
  Partial<AgentIdentityEditorValues>;

export type AgentIdentityEditorOptions = Readonly<{
  definition?: AgentDefinition;
  initialValues?: AgentIdentityEditorInitialValues;
}>;

export function initialAgentIdentityEditorValues({
  definition,
  initialValues
}: AgentIdentityEditorOptions = {}): AgentIdentityEditorValues {
  return {
    name: initialValues?.name ?? definition?.name ?? "",
    role: initialValues?.role ?? definition?.role ?? "",
    avatar: initialValues?.avatar ?? definition?.avatar
  };
}

export function canSubmitAgentIdentity(
  values: Pick<AgentIdentityEditorValues, "name">
): boolean {
  return Boolean(values.name.trim());
}
