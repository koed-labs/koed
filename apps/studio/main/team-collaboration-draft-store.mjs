import { createHash } from "node:crypto";
import { createPdsApplicationSecretStore } from "@koed/shared";

const MAX_DRAFT_BYTES = 128 * 1024;
const MAX_DRAFT_SCOPES_PER_TEAM = 2_000;
const MAX_INDEX_TEAMS = 5_000;
const INDEX_REFERENCE = "team-collaboration-drafts-index-v1";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const processOperationQueues = new Map();

const assertAuthority = (authority) => {
  if (
    !authority ||
    typeof authority.backendId !== "string" ||
    authority.backendId.length < 1 ||
    authority.backendId.length > 240 ||
    !UUID.test(authority.principalUserId) ||
    !UUID.test(authority.teamId) ||
    !UUID.test(authority.threadId) ||
    (authority.rootMessageId !== undefined &&
      authority.rootMessageId !== null &&
      !UUID.test(authority.rootMessageId)) ||
    (authority.editMessageId !== undefined &&
      authority.editMessageId !== null &&
      !UUID.test(authority.editMessageId)) ||
    (authority.rootMessageId != null && authority.editMessageId != null)
  ) {
    throw new Error("Team draft authority is invalid.");
  }
};

const assertTeamAuthority = (authority) => {
  if (
    !authority ||
    typeof authority.backendId !== "string" ||
    authority.backendId.length < 1 ||
    authority.backendId.length > 240 ||
    !UUID.test(authority.principalUserId) ||
    !UUID.test(authority.teamId)
  ) {
    throw new Error("Team draft authority is invalid.");
  }
};

const draftKeyFor = (authority) =>
  authority.rootMessageId == null && authority.editMessageId == null
    ? authority.threadId
    : JSON.stringify([
        authority.threadId,
        authority.rootMessageId ?? null,
        authority.editMessageId ?? null
      ]);

const validDraftKey = (key) => {
  if (UUID.test(key)) return true;
  try {
    const value = JSON.parse(key);
    return (
      Array.isArray(value) &&
      value.length === 3 &&
      UUID.test(value[0]) &&
      (value[1] === null || UUID.test(value[1])) &&
      (value[2] === null || UUID.test(value[2])) &&
      !(value[1] !== null && value[2] !== null)
    );
  } catch {
    return false;
  }
};

const referenceFor = (authority) => {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        authority.backendId,
        authority.principalUserId,
        authority.teamId
      ])
    )
    .digest("hex");
  return `team-collaboration-drafts-${digest}`;
};

const principalScopeFor = (authority) =>
  createHash("sha256")
    .update(JSON.stringify([authority.backendId, authority.principalUserId]))
    .digest("hex");

const validPendingSend = (pendingSend) => {
  if (pendingSend === null) return true;
  return (
    pendingSend &&
    UUID.test(pendingSend.clientMessageId) &&
    typeof pendingSend.body === "string" &&
    Buffer.byteLength(pendingSend.body, "utf8") <= MAX_DRAFT_BYTES &&
    typeof pendingSend.createdAt === "string" &&
    Number.isFinite(Date.parse(pendingSend.createdAt))
  );
};

const validMentionUserIds = (mentionUserIds) =>
  mentionUserIds === undefined ||
  (Array.isArray(mentionUserIds) &&
    mentionUserIds.length <= 40 &&
    new Set(mentionUserIds).size === mentionUserIds.length &&
    mentionUserIds.every(
      (userId) => typeof userId === "string" && UUID.test(userId)
    ));

const validReceiptAckPending = (receiptAckPending) => {
  if (receiptAckPending === undefined || receiptAckPending === null)
    return true;
  return Boolean(
    receiptAckPending &&
    Object.keys(receiptAckPending).sort().join(",") ===
      "clientMessageId,messageId" &&
    UUID.test(receiptAckPending.clientMessageId) &&
    UUID.test(receiptAckPending.messageId)
  );
};

const validEditDraft = (edit) =>
  edit === undefined ||
  Boolean(
    edit &&
    Object.keys(edit).every((key) =>
      ["expectedVersion", "baseBodyText", "conflict"].includes(key)
    ) &&
    Number.isSafeInteger(edit.expectedVersion) &&
    edit.expectedVersion > 0 &&
    typeof edit.baseBodyText === "string" &&
    Buffer.byteLength(edit.baseBodyText, "utf8") <= MAX_DRAFT_BYTES &&
    (edit.conflict === undefined ||
      (edit.conflict &&
        Object.keys(edit.conflict).sort().join(",") ===
          "latestBodyText,latestVersion" &&
        Number.isSafeInteger(edit.conflict.latestVersion) &&
        edit.conflict.latestVersion > edit.expectedVersion &&
        typeof edit.conflict.latestBodyText === "string" &&
        Buffer.byteLength(edit.conflict.latestBodyText, "utf8") <=
          MAX_DRAFT_BYTES))
  );

const parseTeamState = (value, authority) => {
  if (
    !value ||
    value.schemaVersion !== 1 ||
    JSON.stringify(value.authority) !== JSON.stringify(authority) ||
    !value.drafts ||
    typeof value.drafts !== "object" ||
    Array.isArray(value.drafts)
  ) {
    throw new Error("Team draft state is invalid.");
  }
  const entries = Object.entries(value.drafts);
  if (entries.length > MAX_DRAFT_SCOPES_PER_TEAM) {
    throw new Error("Team draft state has too many scopes.");
  }
  for (const [draftKey, draft] of entries) {
    if (
      !validDraftKey(draftKey) ||
      !draft ||
      Object.keys(draft).some(
        (key) =>
          ![
            "text",
            "mentionUserIds",
            "pendingSend",
            "receiptAckPending",
            "edit",
            "updatedAt"
          ].includes(key)
      ) ||
      typeof draft.text !== "string" ||
      Buffer.byteLength(draft.text, "utf8") > MAX_DRAFT_BYTES ||
      !validMentionUserIds(draft.mentionUserIds) ||
      !validPendingSend(draft.pendingSend) ||
      !validReceiptAckPending(draft.receiptAckPending) ||
      !validEditDraft(draft.edit) ||
      typeof draft.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(draft.updatedAt))
    ) {
      throw new Error("Team draft state is invalid.");
    }
  }
  return value;
};

/**
 * Encrypted, device-local Team draft storage for the Studio Electron host.
 * The shared application secret store provides AES-GCM encryption, authenticated
 * references, atomic writes, and owner-only file permissions.
 */
export const createStudioTeamDraftStore = ({ userDataPath }) => {
  if (typeof userDataPath !== "string" || userDataPath.length === 0) {
    throw new Error("Studio user data path is required.");
  }
  const store = createPdsApplicationSecretStore({
    rootPath: userDataPath,
    storeDirectory: ".",
    storeFilename: "team-collaboration-drafts.json",
    keyFilename: "team-collaboration-drafts.key"
  });
  const serial = (reference, operation) => {
    const key = `${userDataPath}:${reference}`;
    const previous = processOperationQueues.get(key) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    processOperationQueues.set(
      key,
      next.then(
        () => undefined,
        () => undefined
      )
    );
    return next;
  };
  const mutate = (operation) =>
    serial("team-drafts-global-mutation-queue", operation);

  const readTeam = (teamAuthority) => {
    const reference = referenceFor(teamAuthority);
    const raw = store.get(reference);
    if (raw === null) {
      return {
        reference,
        value: {
          schemaVersion: 1,
          authority: teamAuthority,
          drafts: {}
        }
      };
    }
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error("Team draft state is invalid.");
    }
    return { reference, value: parseTeamState(value, teamAuthority) };
  };

  const readIndex = () => {
    const raw = store.get(INDEX_REFERENCE);
    if (raw === null) return [];
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error("Team draft index is invalid.");
    }
    if (
      !Array.isArray(value) ||
      value.length > MAX_INDEX_TEAMS ||
      value.some(
        (entry) =>
          !entry ||
          Object.keys(entry).sort().join(",") !== "principalScope,teamScope" ||
          !/^[0-9a-f]{64}$/.test(entry.principalScope) ||
          !/^[0-9a-f]{64}$/.test(entry.teamScope)
      )
    ) {
      throw new Error("Team draft index is invalid.");
    }
    return value;
  };

  const writeIndex = (entries) => {
    const unique = [
      ...new Map(
        entries.map((entry) => [
          `${entry.principalScope}:${entry.teamScope}`,
          entry
        ])
      ).values()
    ];
    if (unique.length > MAX_INDEX_TEAMS) {
      throw new Error("Team draft index has too many entries.");
    }
    if (unique.length === 0) store.delete(INDEX_REFERENCE);
    else store.put(INDEX_REFERENCE, JSON.stringify(unique));
  };

  const registerTeam = async (authority) => {
    const principalScope = principalScopeFor(authority);
    const teamScope = createHash("sha256")
      .update(
        JSON.stringify([
          authority.backendId,
          authority.principalUserId,
          authority.teamId
        ])
      )
      .digest("hex");
    await serial(INDEX_REFERENCE, () => {
      const entries = readIndex();
      writeIndex([...entries, { principalScope, teamScope }]);
    });
  };

  const unregisterTeam = async (authority) => {
    const principalScope = principalScopeFor(authority);
    const teamScope = createHash("sha256")
      .update(
        JSON.stringify([
          authority.backendId,
          authority.principalUserId,
          authority.teamId
        ])
      )
      .digest("hex");
    await serial(INDEX_REFERENCE, () => {
      writeIndex(
        readIndex().filter(
          (entry) =>
            entry.principalScope !== principalScope ||
            entry.teamScope !== teamScope
        )
      );
    });
  };

  return {
    async load(authority) {
      assertAuthority(authority);
      const teamAuthority = {
        backendId: authority.backendId,
        principalUserId: authority.principalUserId,
        teamId: authority.teamId
      };
      const reference = referenceFor(teamAuthority);
      return await serial(reference, () => {
        const { value } = readTeam(teamAuthority);
        const draft = value.drafts[draftKeyFor(authority)];
        return draft ? structuredClone(draft) : null;
      });
    },

    async save({ authority, draft }) {
      assertAuthority(authority);
      if (
        !draft ||
        typeof draft.text !== "string" ||
        Buffer.byteLength(draft.text, "utf8") > MAX_DRAFT_BYTES ||
        !validMentionUserIds(draft.mentionUserIds) ||
        !validPendingSend(draft.pendingSend) ||
        !validReceiptAckPending(draft.receiptAckPending) ||
        !validEditDraft(draft.edit)
      ) {
        throw new Error("Team draft is invalid.");
      }
      const teamAuthority = {
        backendId: authority.backendId,
        principalUserId: authority.principalUserId,
        teamId: authority.teamId
      };
      const reference = referenceFor(teamAuthority);
      await mutate(() =>
        serial(reference, async () => {
          const { value } = readTeam(teamAuthority);
          const nextDrafts = { ...value.drafts };
          const draftKey = draftKeyFor(authority);
          if (
            draft.text.length === 0 &&
            (!draft.mentionUserIds || draft.mentionUserIds.length === 0) &&
            draft.pendingSend === null &&
            !draft.receiptAckPending &&
            !draft.edit
          ) {
            delete nextDrafts[draftKey];
          } else {
            if (
              !Object.hasOwn(nextDrafts, draftKey) &&
              Object.keys(nextDrafts).length >= MAX_DRAFT_SCOPES_PER_TEAM
            ) {
              throw new Error("Team draft state has too many scopes.");
            }
            nextDrafts[draftKey] = {
              text: draft.text,
              ...(draft.mentionUserIds?.length
                ? { mentionUserIds: draft.mentionUserIds }
                : {}),
              pendingSend: draft.pendingSend,
              receiptAckPending: draft.receiptAckPending ?? null,
              ...(draft.edit ? { edit: draft.edit } : {}),
              updatedAt: new Date().toISOString()
            };
          }
          if (Object.keys(nextDrafts).length === 0) {
            store.delete(reference);
            await unregisterTeam(teamAuthority);
          } else {
            await registerTeam(teamAuthority);
            store.put(
              reference,
              JSON.stringify({
                schemaVersion: 1,
                authority: teamAuthority,
                drafts: nextDrafts
              })
            );
          }
        })
      );
    },

    async delete(authority) {
      assertAuthority(authority);
      const teamAuthority = {
        backendId: authority.backendId,
        principalUserId: authority.principalUserId,
        teamId: authority.teamId
      };
      const reference = referenceFor(teamAuthority);
      await mutate(() =>
        serial(reference, async () => {
          const { value } = readTeam(teamAuthority);
          if (!Object.hasOwn(value.drafts, draftKeyFor(authority))) return;
          const nextDrafts = { ...value.drafts };
          delete nextDrafts[draftKeyFor(authority)];
          if (Object.keys(nextDrafts).length === 0) {
            store.delete(reference);
            await unregisterTeam(teamAuthority);
          } else {
            store.put(
              reference,
              JSON.stringify({
                schemaVersion: 1,
                authority: teamAuthority,
                drafts: nextDrafts
              })
            );
          }
        })
      );
    },

    async deleteTeam(authority) {
      assertTeamAuthority(authority);
      const reference = referenceFor(authority);
      await mutate(async () => {
        await serial(reference, () => store.delete(reference));
        await unregisterTeam(authority);
      });
    },

    async retainAuthorizedTeams(authority) {
      if (
        !authority ||
        typeof authority.backendId !== "string" ||
        !authority.backendId ||
        !authority.principalUserId ||
        !Array.isArray(authority.teamIds) ||
        authority.teamIds.some((id) => typeof id !== "string")
      ) {
        throw new Error("Authorized Team draft scope is invalid.");
      }
      return await mutate(async () => {
        const principalScope = principalScopeFor(authority);
        const authorized = new Set(
          authority.teamIds.map((teamId) =>
            createHash("sha256")
              .update(
                JSON.stringify([
                  authority.backendId,
                  authority.principalUserId,
                  teamId
                ])
              )
              .digest("hex")
          )
        );
        const unauthorized = await serial(INDEX_REFERENCE, () => {
          const index = readIndex();
          const removed = index.filter(
            (entry) =>
              entry.principalScope === principalScope &&
              !authorized.has(entry.teamScope)
          );
          return removed.map((entry) => entry.teamScope);
        });
        for (const teamScope of unauthorized) {
          const referenceForScope = `team-collaboration-drafts-${teamScope}`;
          await serial(referenceForScope, () =>
            store.delete(referenceForScope)
          );
        }
        await serial(INDEX_REFERENCE, () => {
          writeIndex(
            readIndex().filter(
              (entry) =>
                entry.principalScope !== principalScope ||
                authorized.has(entry.teamScope)
            )
          );
        });
        return unauthorized.length;
      });
    }
  };
};
