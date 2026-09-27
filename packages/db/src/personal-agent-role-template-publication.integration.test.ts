import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createLocalTestKeyEnvelopeEncryptionProvider } from "@koed/shared";
import { afterAll, describe, expect, it } from "vitest";
import { runDbMigrations } from "./migrate.js";
import { createPersonalAgentRepository } from "./personal-agent-repository.js";
import {
  loadTemplate,
  publishTemplate,
  publishTemplates
} from "../scripts/publish-personal-agent-role-templates.mjs";

const baseUrl = process.env.KOED_ROLE_TEMPLATE_TEST_DATABASE_URL;
const databaseName = `koed_role_templates_${randomUUID().replaceAll("-", "")}`;
const source = fileURLToPath(
  new URL("../../../agent-role-templates/code-reviewer", import.meta.url)
);

describe.skipIf(!baseUrl)(
  "Personal Agent role template publication (PostgreSQL)",
  () => {
    const configuredUrl = baseUrl ? new URL(baseUrl) : null;
    const adminUrl = configuredUrl ? new URL(configuredUrl) : null;
    if (adminUrl) adminUrl.pathname = "/postgres";
    const testUrl = configuredUrl ? new URL(configuredUrl) : null;
    if (testUrl) testUrl.pathname = `/${databaseName}`;
    const admin = adminUrl
      ? new pg.Client({ connectionString: adminUrl.toString() })
      : null;
    const pool = testUrl
      ? new pg.Pool({ connectionString: testUrl.toString() })
      : null;
    let adminConnected = false;

    afterAll(async () => {
      await pool?.end();
      if (!admin || !adminConnected) return;
      try {
        await admin.query(
          "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1",
          [databaseName]
        );
        await admin.query(`drop database if exists "${databaseName}"`);
      } finally {
        await admin.end();
      }
    });

    it("publishes concurrently, rejects changed immutable versions, and preserves edited-copy provenance", async () => {
      if (!admin || !pool) throw new Error("Test database URL is unavailable");
      await admin.connect();
      adminConnected = true;
      await admin.query(`create database "${databaseName}"`);
      await runDbMigrations(pool);
      const template = await loadTemplate(source);
      const repeated = await Promise.all([
        publishTemplate(pool, template),
        publishTemplate(pool, template)
      ]);
      expect(repeated).toEqual([
        { id: template.id, version: template.version },
        { id: template.id, version: template.version }
      ]);

      await expect(
        publishTemplate(pool, {
          ...template,
          soulInstructions: `${template.soulInstructions}\nAdditional content\n`
        })
      ).rejects.toThrow("already exists with different content");
      const unpublished = {
        ...template,
        id: "researcher",
        title: "Researcher",
        role: "Researcher"
      };
      await expect(
        publishTemplates(pool, [
          unpublished,
          {
            ...template,
            soulInstructions: `${template.soulInstructions}\nConflict\n`
          }
        ])
      ).rejects.toThrow("already exists with different content");
      const rolledBack = await pool.query(
        "select 1 from personal_agent_role_template_versions where template_id = 'researcher' and version = 1"
      );
      expect(rolledBack.rowCount).toBe(0);
      await expect(
        pool.query(
          "update personal_agent_role_template_versions set title = 'Changed' where template_id = $1 and version = $2",
          [template.id, template.version]
        )
      ).rejects.toThrow("immutable");
      const templateV2 = await publishTemplate(pool, {
        ...template,
        version: 2,
        soulInstructions: `${template.soulInstructions}\nAdditional responsibility\n`
      });
      expect(templateV2).toEqual({ id: template.id, version: 2 });
      expect(
        (await repositoryTemplates(pool)).find(
          (entry) => entry.id === template.id
        )?.version
      ).toBe(2);

      const ownerId = randomUUID();
      await pool.query(
        "insert into users (id, email, display_name) values ($1, $2, $3)",
        [ownerId, `${ownerId}@role-template-smoke.invalid`, "Template Test"]
      );
      const repository = createPersonalAgentRepository(pool, {
        envelopeEncryptionProvider:
          createLocalTestKeyEnvelopeEncryptionProvider(
            randomBytes(32).toString("base64url")
          )
      });
      const created = await repository.createPersonalAgent(
        { userId: ownerId },
        {
          requestId: randomUUID(),
          name: "Review Agent",
          role: template.role,
          soulInstructions: template.soulInstructions,
          instructionSource: "custom",
          defaultProvider: "codex",
          defaultModel: "gpt-5.6",
          defaultReasoningEffort: "high",
          sourceTemplateId: template.id,
          sourceTemplateVersion: template.version
        }
      );
      const edited = await repository.updatePersonalAgent(
        { userId: ownerId },
        {
          agentId: created.agent.id,
          requestId: randomUUID(),
          expectedVersion: 1,
          name: "Renamed Review Agent",
          defaultModel: "gpt-5.6-luna"
        }
      );
      expect(edited?.soulInstructions.trimEnd()).toBe(
        template.soulInstructions.trimEnd()
      );
      const saved = await repository.getPersonalAgentVersion(
        { userId: ownerId },
        { agentId: created.agent.id, version: 2 }
      );
      expect(saved).toMatchObject({
        sourceTemplateId: template.id,
        sourceTemplateVersion: template.version,
        soulInstructions: template.soulInstructions.trimEnd()
      });
      const editedCopy = await repository.updatePersonalAgent(
        { userId: ownerId },
        {
          agentId: created.agent.id,
          requestId: randomUUID(),
          expectedVersion: 2,
          soulInstructions: "An independent editable copy"
        }
      );
      expect(editedCopy?.soulInstructions).toBe("An independent editable copy");
      const savedCopy = await repository.getPersonalAgentVersion(
        { userId: ownerId },
        { agentId: created.agent.id, version: 3 }
      );
      expect(savedCopy).toMatchObject({
        sourceTemplateId: template.id,
        sourceTemplateVersion: 1,
        soulInstructions: "An independent editable copy"
      });
      await expect(
        repository.createPersonalAgent(
          { userId: ownerId },
          {
            requestId: randomUUID(),
            name: "Invalid Source",
            role: "Reviewer",
            soulInstructions: "Independent copy",
            instructionSource: "custom",
            defaultProvider: "codex",
            defaultModel: "gpt-5.6",
            sourceTemplateId: "unpublished-role",
            sourceTemplateVersion: 1
          }
        )
      ).rejects.toMatchObject({ code: "23503" });
    }, 120_000);
  }
);

async function repositoryTemplates(pool: pg.Pool) {
  const result = await pool.query(
    "select template_id, version, title, role, soul_instructions, content_sha256 from personal_agent_role_template_versions order by template_id, version desc"
  );
  return result.rows.map((row) => ({
    id: row.template_id,
    version: row.version,
    title: row.title,
    role: row.role,
    soulInstructions: row.soul_instructions,
    contentSha256: row.content_sha256
  }));
}
