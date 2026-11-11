import { createHash } from "node:crypto";
import { createPdsApplicationSecretStore } from "@koed-labs/shared";
import {
  v1ConversationIntentSchema,
  v1ProfileSchema,
  v1ProjectIntentSchema,
  v1ProvenanceSchema,
  type V1ConversationIntent,
  type V1Profile,
  type V1ProjectIntent,
  type V1Provenance,
  type V1StateRequest,
  type V1StateResponse
} from "./ipc/v1-state-protocol.js";

export interface V1StateValueStore {
  get(reference: string): Promise<string | null>;
  put(reference: string, value: string): Promise<void>;
}
const emptyProfile = (): V1Profile => ({
  onboarding: { selections: {}, completed: false }
});
const emptyProvenance = (): V1Provenance => ({
  schemaVersion: 1,
  conversations: {},
  projects: {}
});
const maximumValueBytes = 2_000_000;
const stateReference = (scope: string) => {
  if (!/^[0-9a-f]{64}$/u.test(scope))
    throw new TypeError("Invalid V1 owner scope.");
  return `v1-provenance-${scope}`;
};
const parseValue = <T>(
  raw: string | null,
  fallback: T,
  parse: (value: unknown) => T
): T => {
  if (raw === null) return fallback;
  if (Buffer.byteLength(raw, "utf8") > maximumValueBytes)
    throw new Error("V1 state is too large.");
  return parse(JSON.parse(raw));
};
const serialize = (value: unknown): string => {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") > maximumValueBytes)
    throw new Error("V1 state capacity exceeded; no records were discarded.");
  return text;
};

/** The scope comes from an authenticated backend origin and User ID, never from renderer input. */
export const v1OwnerScope = (
  apiOrigin: string,
  ownerUserId: string
): string => {
  const origin = new URL(apiOrigin).href;
  if (!ownerUserId || ownerUserId.length > 512)
    throw new TypeError("Invalid V1 owner ID.");
  return createHash("sha256")
    .update(JSON.stringify({ backend: origin, ownerUserId }))
    .digest("hex");
};

export const createV1State = (input: {
  userDataPath?: string;
  store?: V1StateValueStore;
  ownerIdentity: () => Promise<{ ownerId: string; scopeKey: string }>;
}) => {
  const store =
    input.store ??
    createPdsApplicationSecretStore({
      rootPath:
        input.userDataPath ??
        (() => {
          throw new Error("V1 state path is required.");
        })(),
      storeDirectory: ".",
      storeFilename: "v1-state.json",
      keyFilename: "v1-state.key"
    });
  let tail = Promise.resolve();
  const serial = async <T>(operation: () => Promise<T>): Promise<T> => {
    const work = tail.then(operation, operation);
    tail = work.then(
      () => undefined,
      () => undefined
    );
    return work;
  };
  const profileReference = "v1-local-profile";
  const readProfile = async () =>
    parseValue(await store.get(profileReference), emptyProfile(), (value) =>
      v1ProfileSchema.parse(value)
    );
  const readProvenance = async (reference: string) => {
    const provenance = parseValue(
      await store.get(reference),
      emptyProvenance(),
      (value) => v1ProvenanceSchema.parse(value)
    );
    for (const [key, intent] of Object.entries(provenance.conversations)) {
      if (key !== intent.idempotencyKey)
        throw new Error("V1 Conversation registry is malformed.");
    }
    for (const [key, intent] of Object.entries(provenance.projects)) {
      if (key !== intent.requestId)
        throw new Error("V1 Project registry is malformed.");
    }
    return provenance;
  };
  const request = async (value: V1StateRequest): Promise<V1StateResponse> =>
    serial(async () => {
      if (value.operation === "identity_read") {
        const identity = await input.ownerIdentity();
        stateReference(identity.scopeKey);
        return { operation: value.operation, ...identity };
      }
      if (value.operation === "profile_read")
        return { operation: value.operation, profile: await readProfile() };
      if (value.operation === "profile_write") {
        const profile = v1ProfileSchema.parse(value.profile);
        await store.put(profileReference, serialize(profile));
        return { operation: value.operation, profile };
      }
      const reference = stateReference((await input.ownerIdentity()).scopeKey);
      const provenance = await readProvenance(reference);
      if (value.operation === "provenance_read")
        return { operation: value.operation, provenance };
      if (value.operation === "conversation_intent_put") {
        const intent = v1ConversationIntentSchema.parse(value.intent);
        const previous = provenance.conversations[intent.idempotencyKey];
        if (previous && JSON.stringify(previous) !== JSON.stringify(intent))
          throw new Error(
            "V1 Conversation intent key conflicts with an existing request."
          );
        if (!previous) {
          provenance.conversations[intent.idempotencyKey] = intent;
          await store.put(reference, serialize(provenance));
        }
        return { operation: value.operation, intent: previous ?? intent };
      }
      if (value.operation === "conversation_ack") {
        const previous = provenance.conversations[value.idempotencyKey];
        if (!previous)
          throw new Error("V1 Conversation launch intent is missing.");
        if (previous.executionId && previous.executionId !== value.executionId)
          throw new Error(
            "V1 Conversation execution ID conflicts with acknowledged launch."
          );
        if (
          previous.capturedSessionId &&
          value.capturedSessionId &&
          previous.capturedSessionId !== value.capturedSessionId
        )
          throw new Error(
            "V1 Conversation Session ID conflicts with acknowledged launch."
          );
        if (
          value.projectMembershipConfirmed &&
          (!previous.presentationProjectId ||
            !(value.capturedSessionId ?? previous.capturedSessionId))
        )
          throw new Error(
            "Project membership requires a Project and captured Conversation."
          );
        const intent: V1ConversationIntent = {
          ...previous,
          executionId: value.executionId,
          ...(value.projectMembershipConfirmed
            ? { projectMembershipConfirmed: true }
            : {}),
          capturedSessionId:
            value.capturedSessionId ?? previous.capturedSessionId
        };
        provenance.conversations[value.idempotencyKey] = intent;
        await store.put(reference, serialize(provenance));
        return { operation: value.operation, intent };
      }
      if (value.operation === "conversation_prompt") {
        const previous = provenance.conversations[value.idempotencyKey];
        if (!previous?.executionId)
          throw new Error("V1 Conversation launch is not acknowledged.");
        if (
          previous.initialPrompt &&
          previous.initialPrompt.clientUserMessageId !==
            value.initialPrompt.clientUserMessageId
        )
          throw new Error(
            "V1 first prompt identity conflicts with a pending send."
          );
        const intent: V1ConversationIntent = {
          ...previous,
          initialPrompt: value.initialPrompt
        };
        provenance.conversations[value.idempotencyKey] = intent;
        await store.put(reference, serialize(provenance));
        return { operation: value.operation, intent };
      }
      if (value.operation === "project_intent_put") {
        const intent = v1ProjectIntentSchema.parse(value.intent);
        const previous = provenance.projects[intent.requestId];
        if (previous && JSON.stringify(previous) !== JSON.stringify(intent))
          throw new Error(
            "V1 Project intent ID conflicts with an existing request."
          );
        if (!previous) {
          provenance.projects[intent.requestId] = intent;
          await store.put(reference, serialize(provenance));
        }
        return { operation: value.operation, intent: previous ?? intent };
      }
      if (value.operation === "project_folder_ack") {
        const previous = provenance.projects[value.requestId];
        if (!previous?.projectId || !previous.folder)
          throw new Error("V1 Project Folder intent is missing.");
        const intent: V1ProjectIntent = { ...previous, folderAttached: true };
        provenance.projects[value.requestId] = intent;
        await store.put(reference, serialize(provenance));
        return { operation: value.operation, intent };
      }
      const previous = provenance.projects[value.requestId];
      if (!previous) throw new Error("V1 Project creation intent is missing.");
      if (previous.projectId && previous.projectId !== value.projectId)
        throw new Error("V1 Project ID conflicts with acknowledged creation.");
      const intent: V1ProjectIntent = {
        ...previous,
        projectId: value.projectId
      };
      provenance.projects[value.requestId] = intent;
      await store.put(reference, serialize(provenance));
      return { operation: "project_ack", intent };
    });
  return { request };
};
