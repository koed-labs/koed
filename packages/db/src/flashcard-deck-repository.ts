import { randomUUID, createHash } from "node:crypto";
import type pg from "pg";
import type { CreateDeck, CreateTeamDeck, Deck } from "@koed/shared";
import type { EnvelopeEncryptionProvider } from "@koed/shared";
import { appendCollaborationOutboxEventWithClient } from "./collaboration-repository.js";
import { claimedManagedTextCreateWithClient } from "./managed-text-action-repository.js";
import {
  deckCreateFromTextAction,
  teamDeckTextActionHash
} from "./managed-deck-action.js";
import { notifyProjectChange } from "./workspace-project-repository.js";

type Client = pg.Pool | pg.PoolClient;
type Row = Record<string, unknown>;
const iso = (v: unknown) => new Date(v as Date).toISOString();
const nullable = (v: unknown): string | null => {
  if (v == null) return null;
  if (typeof v !== "string") throw new Error("Expected string column");
  return v;
};
const card = (r: Row) => ({
  id: String(r.id),
  deckId: String(r.deck_id),
  question: String(r.question),
  answer: String(r.answer),
  sourceRef: nullable(r.source_ref),
  topicLabel: nullable(r.topic_label),
  version: Number(r.version),
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at)
});
const deck = (r: Row, cards: ReturnType<typeof card>[]): Deck => ({
  id: String(r.id),
  projectId: String(r.project_id ?? r.workspace_project_id),
  title: String(r.title),
  scope: String(r.scope),
  madeFrom: String(r.made_from),
  createdByAgentId: nullable(r.created_by_agent_id),
  uses: Number(r.uses),
  version: Number(r.version),
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
  cards
});
const tx = async <T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>) => {
  const c = await pool.connect();
  try {
    await c.query("begin");
    const out = await fn(c);
    await c.query("commit");
    return out;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
};
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const personalChanged = (c: pg.PoolClient, userId: string, projectId: string) =>
  appendCollaborationOutboxEventWithClient(c, {
    family: "project_changed",
    scope: "personal",
    personalOwnerUserId: userId,
    teamId: null,
    teamWorkspaceId: null,
    threadId: null,
    messageId: null,
    shareGrantId: null,
    logicalMemoryId: null,
    resourceType: "project",
    resourceId: projectId,
    actorPrincipalId: userId,
    mutationId: randomUUID()
  });
const teamChanged = async (
  c: pg.PoolClient,
  p: Row,
  userId: string,
  deckId: string
) => {
  await c.query(
    "update workspace_projects set version=version+1,updated_at=now() where id=$1",
    [p.id]
  );
  await notifyProjectChange(c, {
    teamId: String(p.team_id),
    workspaceId: String(p.workspace_id),
    actorUserId: userId,
    resourceType: "workspace_project_deck",
    resourceId: deckId
  });
};
export class DeckUnavailableError extends Error {}
export class DeckConflictError extends Error {}
const personal = async (
  c: Client,
  userId: string,
  projectId: string,
  write = false
) => {
  const r = (
    await c.query<Row>(
      `select id,team_backend_id,workspace_project_id from projects where id=$1 and owner_user_id=$2 and lifecycle='active' and deletion_phase is null ${write ? "for update" : ""}`,
      [projectId, userId]
    )
  ).rows[0];
  if (!r || r.team_backend_id || r.workspace_project_id)
    throw new DeckUnavailableError("Personal Project Deck unavailable");
  if (write) {
    const attempt = await c.query(
      "select 1 from personal_workspace_project_share_attempts where personal_project_id=$1 and owner_user_id=$2 and state='pending'",
      [projectId, userId]
    );
    if (attempt.rowCount)
      throw new DeckConflictError("Project first-share copy is pending");
  }
};
const team = async (
  c: Client,
  userId: string,
  projectId: string,
  write = false,
  lock = write
) => {
  if (lock) {
    const identity = (
      await c.query<Row>(
        "select team_id,workspace_id from workspace_projects where id=$1",
        [projectId]
      )
    ).rows[0];
    if (!identity)
      throw new DeckUnavailableError("Workspace Project unavailable");
    await c.query("select id from teams where id=$1 for update", [
      identity.team_id
    ]);
    const m = (
      await c.query<Row>(
        "select id from team_memberships where team_id=$1 and user_id=$2 for update",
        [identity.team_id, userId]
      )
    ).rows[0];
    if (!m)
      throw new DeckUnavailableError("Workspace Project access unavailable");
    await c.query("select id from team_workspaces where id=$1 for update", [
      identity.workspace_id
    ]);
    await c.query(
      "select team_workspace_id from team_workspace_access_grants where team_workspace_id=$1 and team_id=$2 and user_id=$3 for update",
      [identity.workspace_id, identity.team_id, userId]
    );
    await c.query("select id from workspace_projects where id=$1 for update", [
      projectId
    ]);
    await c.query(
      "select team_member_id from workspace_project_members where workspace_project_id=$1 and team_member_id=$2 for update",
      [projectId, m.id]
    );
  }
  const r = (
    await c.query<Row>(
      `select p.*,m.id as actor_team_member_id,pm.access as project_access,pm.version as actor_member_version,wa.access as workspace_access from workspace_projects p join team_memberships m on m.team_id=p.team_id and m.user_id=$2 and m.status='enabled' and m.disabled_at is null join workspace_project_members pm on pm.workspace_project_id=p.id and pm.team_member_id=m.id and pm.disabled_at is null join team_workspace_access_grants wa on wa.team_workspace_id=p.workspace_id and wa.team_id=p.team_id and wa.user_id=$2 and wa.disabled_at is null join teams t on t.id=p.team_id and t.lifecycle='active' join team_workspaces w on w.id=p.workspace_id and w.lifecycle='active' where p.id=$1 and p.lifecycle='active'`,
      [projectId, userId]
    )
  ).rows[0];
  if (
    !r ||
    r.project_access === "disabled" ||
    r.workspace_access === "disabled" ||
    (write && (r.project_access !== "write" || r.workspace_access !== "write"))
  )
    throw new DeckUnavailableError("Workspace Project access unavailable");
  return r;
};
const get = async (
  c: Client,
  shared: boolean,
  projectId: string,
  deckId: string
) => {
  const dt = shared ? "workspace_project_decks" : "project_decks";
  const ct = shared ? "workspace_project_deck_cards" : "deck_cards";
  const pc = shared ? "workspace_project_id" : "project_id";
  const d = (
    await c.query<Row>(
      `select * from ${dt} where id=$1 and ${pc}=$2 and deleted_at is null`,
      [deckId, projectId]
    )
  ).rows[0];
  if (!d) throw new DeckUnavailableError("Deck unavailable");
  const cards = (
    await c.query<Row>(
      `select * from ${ct} where deck_id=$1 and deleted_at is null order by created_at,id`,
      [deckId]
    )
  ).rows.map(card);
  return deck(d, cards);
};
export const createFlashcardDeckRepository = (pool: pg.Pool) => ({
  async createPersonal(
    userId: string,
    projectId: string,
    input: CreateDeck,
    textAction?: {
      actionId: string;
      encryptionProvider: EnvelopeEncryptionProvider;
    }
  ) {
    return tx(pool, async (c) => {
      await personal(c, userId, projectId, true);
      if (textAction) {
        const current = (
          await c.query<{ version: number }>(
            "select version from projects where id=$1 and owner_user_id=$2 for share",
            [projectId, userId]
          )
        ).rows[0];
        if (
          !current ||
          input.idempotencyKey !== textAction.actionId ||
          !(await claimedManagedTextCreateWithClient(
            c,
            textAction.encryptionProvider,
            {
              ownerUserId: userId,
              actionId: textAction.actionId,
              name: "koed_deck_make",
              matches: (args, snapshot) =>
                args.projectId === projectId &&
                snapshot.projectId === projectId &&
                snapshot.projectVersion === current.version &&
                typeof snapshot.agentId === "string" &&
                JSON.stringify(
                  deckCreateFromTextAction(
                    textAction.actionId,
                    args,
                    snapshot.agentId
                  )
                ) === JSON.stringify(input)
            }
          ))
        )
          throw new DeckUnavailableError("Reviewed Deck action changed");
      }
      const hash = digest(input);
      const existing = (
        await c.query<Row>(
          "select id,creation_payload_hash,deleted_at from project_decks where owner_user_id=$1 and project_id=$2 and idempotency_key=$3 for update",
          [userId, projectId, input.idempotencyKey]
        )
      ).rows[0];
      if (existing) {
        if (existing.creation_payload_hash !== hash || existing.deleted_at)
          throw new DeckConflictError("Deck creation key changed");
        if (
          textAction &&
          !(
            await c.query(
              "select 1 from managed_conversation_text_action_create_effects where action_id=$1 and owner_user_id=$2 and project_id=$3 and work_item_id is null",
              [textAction.actionId, userId, projectId]
            )
          ).rowCount
        )
          throw new DeckConflictError("Deck action receipt is missing");
        return get(c, false, projectId, String(existing.id));
      }
      const id = randomUUID();
      await c.query(
        "insert into project_decks(id,owner_user_id,project_id,title,scope,made_from,created_by_agent_id,idempotency_key,creation_payload_hash) values($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          id,
          userId,
          projectId,
          input.title,
          input.scope,
          input.madeFrom,
          input.createdByAgentId ?? null,
          input.idempotencyKey,
          hash
        ]
      );
      for (const x of input.cards)
        await c.query(
          "insert into deck_cards(id,owner_user_id,deck_id,question,answer,source_ref,topic_label) values($1,$2,$3,$4,$5,$6,$7)",
          [
            randomUUID(),
            userId,
            id,
            x.question,
            x.answer,
            x.sourceRef ?? null,
            x.topicLabel ?? null
          ]
        );
      if (textAction)
        await c.query(
          "insert into managed_conversation_text_action_create_effects(action_id,owner_user_id,project_id) values($1,$2,$3)",
          [textAction.actionId, userId, projectId]
        );
      await personalChanged(c, userId, projectId);
      return get(c, false, projectId, id);
    });
  },
  async listPersonal(userId: string, projectId: string) {
    await personal(pool, userId, projectId);
    const rows = (
      await pool.query<Row>(
        "select id from project_decks where owner_user_id=$1 and project_id=$2 and deleted_at is null order by created_at,id",
        [userId, projectId]
      )
    ).rows;
    return {
      decks: await Promise.all(
        rows.map((r) => get(pool, false, projectId, String(r.id)))
      )
    };
  },
  async getPersonalByCreationKey(
    userId: string,
    projectId: string,
    key: string
  ) {
    await personal(pool, userId, projectId);
    const found = await pool.query<Row>(
      "select id from project_decks where owner_user_id=$1 and project_id=$2 and idempotency_key=$3 and deleted_at is null",
      [userId, projectId, key]
    );
    return found.rows[0]
      ? get(pool, false, projectId, String(found.rows[0].id))
      : null;
  },
  async getPersonalCreationLocation(
    userId: string,
    projectId: string,
    key: string
  ) {
    const project = (
      await pool.query<Row>(
        "select team_backend_id,workspace_project_id from projects where id=$1 and owner_user_id=$2 and lifecycle='active' and deletion_phase is null",
        [projectId, userId]
      )
    ).rows[0];
    if (!project) return null;
    const original = (
      await pool.query<Row>(
        "select id from project_decks where owner_user_id=$1 and project_id=$2 and idempotency_key=$3 and deleted_at is null",
        [userId, projectId, key]
      )
    ).rows[0];
    return {
      sourceDeckId: original ? String(original.id) : null,
      teamBackendId: nullable(project.team_backend_id),
      workspaceProjectId: nullable(project.workspace_project_id)
    };
  },
  async getPersonal(userId: string, projectId: string, deckId: string) {
    await personal(pool, userId, projectId);
    if (
      !(
        await pool.query(
          "select 1 from project_decks where id=$1 and owner_user_id=$2",
          [deckId, userId]
        )
      ).rowCount
    )
      throw new DeckUnavailableError("Deck unavailable");
    return get(pool, false, projectId, deckId);
  },
  async createTeam(
    userId: string,
    projectId: string,
    input: CreateTeamDeck,
    textAction?: {
      nonce: string;
      teamBackendId: string;
      runnerDeviceId: string;
      deviceCredentialKeyId: string;
      expectedProjectVersion: number;
      expectedMemberVersion: number;
    }
  ) {
    return tx(pool, async (c) => {
      const p = await team(c, userId, projectId, true);
      if (
        textAction &&
        (Number(p.version) !== textAction.expectedProjectVersion ||
          Number(p.actor_member_version) !== textAction.expectedMemberVersion)
      )
        throw new DeckConflictError("Reviewed Team Project version changed");
      const hash = textAction
        ? teamDeckTextActionHash({
            actionId: input.idempotencyKey,
            teamBackendId: textAction.teamBackendId,
            workspaceProjectId: projectId,
            teamUserId: userId,
            runnerDeviceId: textAction.runnerDeviceId,
            deviceCredentialKeyId: textAction.deviceCredentialKeyId,
            operationFamily: "team_workspace_write",
            payload: input,
            nonce: textAction.nonce
          })
        : digest(input);
      const existing = (
        await c.query<Row>(
          "select id,creation_payload_hash,deleted_at from workspace_project_decks where workspace_project_id=$1 and created_by_team_member_id=$2 and idempotency_key=$3 for update",
          [projectId, p.actor_team_member_id, input.idempotencyKey]
        )
      ).rows[0];
      if (existing) {
        if (existing.creation_payload_hash !== hash || existing.deleted_at)
          throw new DeckConflictError("Deck creation key changed");
        return get(c, true, projectId, String(existing.id));
      }
      const id = randomUUID();
      await c.query(
        "insert into workspace_project_decks(id,workspace_project_id,created_by_team_member_id,title,scope,made_from,idempotency_key,creation_payload_hash) values($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          id,
          projectId,
          p.actor_team_member_id,
          input.title,
          input.scope,
          input.madeFrom,
          input.idempotencyKey,
          hash
        ]
      );
      for (const x of input.cards)
        await c.query(
          "insert into workspace_project_deck_cards(id,workspace_project_id,deck_id,question,answer,source_ref,topic_label) values($1,$2,$3,$4,$5,$6,$7)",
          [
            randomUUID(),
            projectId,
            id,
            x.question,
            x.answer,
            x.sourceRef ?? null,
            x.topicLabel ?? null
          ]
        );
      await teamChanged(c, p, userId, id);
      return get(c, true, projectId, id);
    });
  },
  async getTeamByCreationKey(userId: string, projectId: string, key: string) {
    const member = await team(pool, userId, projectId, false);
    const found = await pool.query<Row>(
      "select id,creation_payload_hash from workspace_project_decks where workspace_project_id=$1 and created_by_team_member_id=$2 and idempotency_key=$3 and deleted_at is null",
      [projectId, member.actor_team_member_id, key]
    );
    return found.rows[0]
      ? {
          deck: await get(pool, true, projectId, String(found.rows[0].id)),
          creationPayloadHash: String(found.rows[0].creation_payload_hash)
        }
      : null;
  },
  async getTeamBySourceDeckId(
    userId: string,
    projectId: string,
    sourceDeckId: string
  ) {
    const member = await team(pool, userId, projectId, false);
    const found = await pool.query<Row>(
      "select id from workspace_project_decks where workspace_project_id=$1 and created_by_team_member_id=$2 and source_deck_id=$3 and deleted_at is null",
      [projectId, member.actor_team_member_id, sourceDeckId]
    );
    return found.rows[0]
      ? get(pool, true, projectId, String(found.rows[0].id))
      : null;
  },
  async listTeam(userId: string, projectId: string) {
    return tx(pool, async (c) => {
      await team(c, userId, projectId, false, true);
      const rows = (
        await c.query<Row>(
          "select id from workspace_project_decks where workspace_project_id=$1 and deleted_at is null order by created_at,id",
          [projectId]
        )
      ).rows;
      return {
        decks: await Promise.all(
          rows.map((r) => get(c, true, projectId, String(r.id)))
        )
      };
    });
  },
  async getTeam(userId: string, projectId: string, deckId: string) {
    return tx(pool, async (c) => {
      await team(c, userId, projectId, false, true);
      return get(c, true, projectId, deckId);
    });
  },
  async patchDeck(
    userId: string,
    projectId: string,
    deckId: string,
    shared: boolean,
    input: {
      expectedVersion: number;
      title?: string;
      scope?: string;
      madeFrom?: string;
    }
  ) {
    return tx(pool, async (c) => {
      const p = shared
        ? await team(c, userId, projectId, true)
        : (await personal(c, userId, projectId, true), null);
      const table = shared ? "workspace_project_decks" : "project_decks",
        pc = shared ? "workspace_project_id" : "project_id";
      const row = (
        await c.query<Row>(
          `select * from ${table} where id=$1 and ${pc}=$2 and deleted_at is null for update`,
          [deckId, projectId]
        )
      ).rows[0];
      if (!row || (!shared && row.owner_user_id !== userId))
        throw new DeckUnavailableError("Deck unavailable");
      if (Number(row.version) !== input.expectedVersion)
        throw new DeckConflictError("Deck version changed");
      await c.query(
        `update ${table} set title=$3,scope=$4,made_from=$5,version=version+1,updated_at=now() where id=$1 and ${pc}=$2`,
        [
          deckId,
          projectId,
          input.title ?? row.title,
          input.scope ?? row.scope,
          input.madeFrom ?? row.made_from
        ]
      );
      if (shared) await teamChanged(c, p!, userId, deckId);
      else await personalChanged(c, userId, projectId);
      return get(c, shared, projectId, deckId);
    });
  },
  async addCard(
    userId: string,
    projectId: string,
    deckId: string,
    shared: boolean,
    input: {
      question: string;
      answer: string;
      sourceRef?: string | null;
      topicLabel?: string | null;
      expectedDeckVersion: number;
    }
  ) {
    return tx(pool, async (c) => {
      const p = shared
        ? await team(c, userId, projectId, true)
        : (await personal(c, userId, projectId, true), null);
      const table = shared ? "workspace_project_decks" : "project_decks",
        ct = shared ? "workspace_project_deck_cards" : "deck_cards",
        pc = shared ? "workspace_project_id" : "project_id";
      const row = (
        await c.query<Row>(
          `select * from ${table} where id=$1 and ${pc}=$2 and deleted_at is null for update`,
          [deckId, projectId]
        )
      ).rows[0];
      if (!row || (!shared && row.owner_user_id !== userId))
        throw new DeckUnavailableError("Deck unavailable");
      if (Number(row.version) !== input.expectedDeckVersion)
        throw new DeckConflictError("Deck version changed");
      const id = randomUUID();
      if (shared)
        await c.query(
          `insert into ${ct}(id,workspace_project_id,deck_id,question,answer,source_ref,topic_label) values($1,$2,$3,$4,$5,$6,$7)`,
          [
            id,
            projectId,
            deckId,
            input.question,
            input.answer,
            input.sourceRef ?? null,
            input.topicLabel ?? null
          ]
        );
      else
        await c.query(
          `insert into ${ct}(id,owner_user_id,deck_id,question,answer,source_ref,topic_label) values($1,$2,$3,$4,$5,$6,$7)`,
          [
            id,
            userId,
            deckId,
            input.question,
            input.answer,
            input.sourceRef ?? null,
            input.topicLabel ?? null
          ]
        );
      await c.query(
        `update ${table} set version=version+1,updated_at=now() where id=$1`,
        [deckId]
      );
      if (shared) await teamChanged(c, p!, userId, deckId);
      else await personalChanged(c, userId, projectId);
      return get(c, shared, projectId, deckId);
    });
  },
  async patchCard(
    userId: string,
    projectId: string,
    deckId: string,
    cardId: string,
    shared: boolean,
    input: {
      expectedVersion: number;
      question?: string;
      answer?: string;
      sourceRef?: string | null;
      topicLabel?: string | null;
    }
  ) {
    return tx(pool, async (c) => {
      const p = shared
        ? await team(c, userId, projectId, true)
        : (await personal(c, userId, projectId, true), null);
      const dt = shared ? "workspace_project_decks" : "project_decks",
        ct = shared ? "workspace_project_deck_cards" : "deck_cards",
        pc = shared ? "workspace_project_id" : "project_id";
      const d = (
        await c.query<Row>(
          `select * from ${dt} where id=$1 and ${pc}=$2 and deleted_at is null for update`,
          [deckId, projectId]
        )
      ).rows[0];
      if (!d || (!shared && d.owner_user_id !== userId))
        throw new DeckUnavailableError("Deck unavailable");
      const r = (
        await c.query<Row>(
          `select * from ${ct} where id=$1 and deck_id=$2 and deleted_at is null for update`,
          [cardId, deckId]
        )
      ).rows[0];
      if (!r) throw new DeckUnavailableError("Card unavailable");
      if (Number(r.version) !== input.expectedVersion)
        throw new DeckConflictError("Card version changed");
      await c.query(
        `update ${ct} set question=$3,answer=$4,source_ref=$5,topic_label=$6,version=version+1,updated_at=now() where id=$1 and deck_id=$2`,
        [
          cardId,
          deckId,
          input.question ?? r.question,
          input.answer ?? r.answer,
          input.sourceRef === undefined ? r.source_ref : input.sourceRef,
          input.topicLabel === undefined ? r.topic_label : input.topicLabel
        ]
      );
      await c.query(
        `update ${dt} set version=version+1,updated_at=now() where id=$1`,
        [deckId]
      );
      if (shared) await teamChanged(c, p!, userId, deckId);
      else await personalChanged(c, userId, projectId);
      return get(c, shared, projectId, deckId);
    });
  },
  async deleteDeck(
    userId: string,
    projectId: string,
    deckId: string,
    shared: boolean,
    expectedVersion: number
  ) {
    return tx(pool, async (c) => {
      const p = shared
        ? await team(c, userId, projectId, true)
        : (await personal(c, userId, projectId, true), null);
      const dt = shared ? "workspace_project_decks" : "project_decks",
        pc = shared ? "workspace_project_id" : "project_id";
      const d = (
        await c.query<Row>(
          `select * from ${dt} where id=$1 and ${pc}=$2 and deleted_at is null for update`,
          [deckId, projectId]
        )
      ).rows[0];
      if (!d || (!shared && d.owner_user_id !== userId))
        throw new DeckUnavailableError("Deck unavailable");
      if (Number(d.version) !== expectedVersion)
        throw new DeckConflictError("Deck version changed");
      await c.query(
        `update ${dt} set deleted_at=now(),version=version+1,updated_at=now() where id=$1`,
        [deckId]
      );
      if (shared) await teamChanged(c, p!, userId, deckId);
      else await personalChanged(c, userId, projectId);
      return { deleted: true };
    });
  },
  async copyMapTeam(userId: string, projectId: string) {
    return tx(pool, async (c) => {
      const p = await team(c, userId, projectId, false, true);
      if (p.owner_team_member_id !== p.actor_team_member_id || !p.copied_at)
        throw new DeckUnavailableError("Owner Deck copy unavailable");
      const rows = (
        await c.query<{
          source_deck_id: string;
          deck_id: string;
          source_card_id: string;
          card_id: string;
        }>(
          `select d.source_deck_id,d.id as deck_id,c.source_card_id,c.id as card_id
    from workspace_project_decks d join workspace_project_deck_cards c on c.deck_id=d.id
        where d.workspace_project_id=$1 and d.created_by_team_member_id=$2 and d.source_deck_id is not null and c.source_card_id is not null`,
          [projectId, p.actor_team_member_id]
        )
      ).rows;
      return {
        projectId,
        copyManifestHash: String(p.copy_manifest_hash),
        cards: rows.map((r) => ({
          sourceDeckId: r.source_deck_id,
          deckId: r.deck_id,
          sourceCardId: r.source_card_id,
          cardId: r.card_id
        }))
      };
    });
  },
  async copyBackDecksTeam(
    userId: string,
    projectId: string,
    expectedVersion: number
  ) {
    return tx(pool, async (c) => {
      const p = await team(c, userId, projectId, false, true);
      if (
        p.owner_team_member_id !== p.actor_team_member_id ||
        Number(p.version) !== expectedVersion
      )
        throw new DeckConflictError("Workspace Project changed");
      const rows = (
        await c.query<Row>(
          `select d.*,c.id as card_id,c.source_card_id,c.question,c.answer,c.source_ref,c.topic_label from workspace_project_decks d left join workspace_project_deck_cards c on c.deck_id=d.id and c.deleted_at is null where d.workspace_project_id=$1 and d.deleted_at is null order by d.created_at,d.id,c.created_at,c.id`,
          [projectId]
        )
      ).rows;
      const byId = new Map<
        string,
        {
          id: string;
          sourceOwnerTeamMemberId: string;
          sourceDeckId: string | null;
          title: string;
          scope: string;
          madeFrom: string;
          createdByAgentId: string | null;
          cards: Array<{
            id: string;
            sourceCardId: string | null;
            question: string;
            answer: string;
            sourceRef: string | null;
            topicLabel: string | null;
          }>;
        }
      >();
      for (const r of rows) {
        let d = byId.get(String(r.id));
        if (!d) {
          d = {
            id: String(r.id),
            sourceOwnerTeamMemberId: String(r.created_by_team_member_id),
            sourceDeckId: nullable(r.source_deck_id),
            title: String(r.title),
            scope: String(r.scope),
            madeFrom: String(r.made_from),
            createdByAgentId: nullable(r.created_by_agent_id),
            cards: []
          };
          byId.set(d.id, d);
        }
        if (r.card_id)
          d.cards.push({
            id: nullable(r.card_id)!,
            sourceCardId: nullable(r.source_card_id),
            question: String(r.question),
            answer: String(r.answer),
            sourceRef: nullable(r.source_ref),
            topicLabel: nullable(r.topic_label)
          });
      }
      return {
        projectId,
        projectVersion: Number(p.version),
        decks: [...byId.values()]
      };
    });
  },
  async progress(userId: string, projectId: string) {
    const p = (
      await pool.query<Row>(
        "select team_backend_id,workspace_project_id from projects where id=$1 and owner_user_id=$2 and lifecycle='active' and deletion_phase is null",
        [projectId, userId]
      )
    ).rows[0];
    if (!p) throw new DeckUnavailableError("Project unavailable");
    const backend = nullable(p.team_backend_id),
      workspace = nullable(p.workspace_project_id);
    const rows = (
      await pool.query<Row>(
        `select progress.card_id,progress.deck_id,progress.box,progress.next_at,progress.misses from deck_card_progress progress
    ${backend ? "" : `join deck_cards card on card.id=progress.card_id and card.owner_user_id=progress.owner_user_id and card.deck_id=progress.deck_id and card.deleted_at is null join project_decks deck on deck.id=card.deck_id and deck.owner_user_id=progress.owner_user_id and deck.project_id=progress.personal_project_id and deck.deleted_at is null`}
    where progress.owner_user_id=$1 and progress.personal_project_id=$2 and progress.team_backend_id is not distinct from $3 and progress.workspace_project_id is not distinct from $4`,
        [userId, projectId, backend, workspace]
      )
    ).rows;
    return {
      link: { teamBackendId: backend, workspaceProjectId: workspace },
      progress: rows.map((r) => ({
        cardId: String(r.card_id),
        deckId: String(r.deck_id),
        box: Number(r.box),
        nextAt: r.next_at ? iso(r.next_at) : null,
        misses: Number(r.misses)
      }))
    };
  },
  async putProgress(
    userId: string,
    projectId: string,
    deckId: string,
    cardId: string,
    input: { box: number; nextAt: string | null; misses: number },
    validated?: { teamBackendId: string; workspaceProjectId: string }
  ) {
    return tx(pool, async (c) => {
      const p = (
        await c.query<Row>(
          "select team_backend_id,workspace_project_id from projects where id=$1 and owner_user_id=$2 and lifecycle='active' and deletion_phase is null for update",
          [projectId, userId]
        )
      ).rows[0];
      if (!p) throw new DeckUnavailableError("Project unavailable");
      const backend = nullable(p.team_backend_id),
        workspace = nullable(p.workspace_project_id);
      if (backend || workspace) {
        if (
          !validated ||
          validated.teamBackendId !== backend ||
          validated.workspaceProjectId !== workspace
        )
          throw new DeckUnavailableError("Shared Deck authority unavailable");
      } else {
        if (validated) throw new DeckUnavailableError("Project link changed");
        const found = await c.query(
          "select 1 from deck_cards card join project_decks deck on deck.id=card.deck_id and deck.owner_user_id=card.owner_user_id where card.id=$1 and card.deck_id=$2 and card.owner_user_id=$3 and deck.project_id=$4 and card.deleted_at is null and deck.deleted_at is null",
          [cardId, deckId, userId, projectId]
        );
        if (!found.rowCount) throw new DeckUnavailableError("Card unavailable");
      }
      await c.query(
        "insert into deck_card_progress(owner_user_id,personal_project_id,team_backend_id,workspace_project_id,deck_id,card_id,box,next_at,misses) values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict(owner_user_id,personal_project_id,card_id) do update set team_backend_id=excluded.team_backend_id,workspace_project_id=excluded.workspace_project_id,deck_id=excluded.deck_id,box=excluded.box,next_at=excluded.next_at,misses=excluded.misses,updated_at=now()",
        [
          userId,
          projectId,
          backend,
          workspace,
          deckId,
          cardId,
          input.box,
          input.nextAt,
          input.misses
        ]
      );
      return { cardId, ...input };
    });
  }
});
