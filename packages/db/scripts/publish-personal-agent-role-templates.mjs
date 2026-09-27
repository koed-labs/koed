import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";

const { Pool } = pg;
const sourceRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../agent-role-templates"
);
const requiredSections = [
  "Identity",
  "Working habits",
  "Responsibilities",
  "Quality bar",
  "Ask boundaries"
];

export function validateTemplate(meta, soulInstructions) {
  if (
    !meta ||
    Object.keys(meta).sort().join(",") !== "id,role,title,version" ||
    typeof meta.id !== "string" ||
    !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(meta.id) ||
    !Number.isInteger(meta.version) ||
    meta.version < 1 ||
    typeof meta.title !== "string" ||
    meta.title.trim().length < 1 ||
    meta.title.length > 128 ||
    typeof meta.role !== "string" ||
    meta.role.trim().length < 1 ||
    meta.role.length > 160
  ) {
    throw new Error("Invalid role template metadata");
  }
  if (
    typeof soulInstructions !== "string" ||
    soulInstructions.trim().length < 1 ||
    Buffer.byteLength(soulInstructions, "utf8") > 65_536
  ) {
    throw new Error(`Invalid soul.md content for ${meta.id}`);
  }
  for (const section of requiredSections) {
    if (!new RegExp(`^# ${section}$`, "m").test(soulInstructions)) {
      throw new Error(`${meta.id} must include a # ${section} section`);
    }
  }
  return {
    id: meta.id,
    version: meta.version,
    title: meta.title.trim(),
    role: meta.role.trim(),
    soulInstructions,
    contentSha256: createHash("sha256").update(soulInstructions).digest("hex")
  };
}

export async function loadTemplate(directory) {
  const metadata = JSON.parse(
    await readFile(resolve(directory, "template.json"), "utf8")
  );
  const soul = await readFile(resolve(directory, "soul.md"), "utf8");
  const template = validateTemplate(metadata, soul);
  if (resolve(directory).split("/").at(-1) !== template.id) {
    throw new Error(`Directory name must match template ID ${template.id}`);
  }
  return template;
}

export async function publishTemplate(client, template) {
  const validated = validateTemplate(
    {
      id: template.id,
      version: template.version,
      title: template.title,
      role: template.role
    },
    template.soulInstructions
  );
  await client.query(
    `insert into personal_agent_role_template_versions
      (template_id, version, title, role, soul_instructions, content_sha256)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (template_id, version) do nothing`,
    [
      validated.id,
      validated.version,
      validated.title,
      validated.role,
      validated.soulInstructions,
      validated.contentSha256
    ]
  );
  const stored = await client.query(
    `select title, role, soul_instructions, content_sha256
     from personal_agent_role_template_versions
     where template_id = $1 and version = $2`,
    [validated.id, validated.version]
  );
  const row = stored.rows[0];
  if (
    !row ||
    row.title !== validated.title ||
    row.role !== validated.role ||
    row.soul_instructions !== validated.soulInstructions ||
    row.content_sha256 !== validated.contentSha256
  ) {
    throw new Error(
      `Published role template ${validated.id}@${validated.version} already exists with different content`
    );
  }
  return { id: validated.id, version: validated.version };
}

export async function publishTemplates(pool, templates) {
  const validated = templates.map((template) =>
    validateTemplate(
      {
        id: template.id,
        version: template.version,
        title: template.title,
        role: template.role
      },
      template.soulInstructions
    )
  );
  const client = await pool.connect();
  try {
    await client.query("begin");
    const published = [];
    for (const template of validated) {
      published.push(await publishTemplate(client, template));
    }
    await client.query("commit");
    return published;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const connectionString = process.env.KOED_ROLE_TEMPLATE_PUBLISH_DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "Set KOED_ROLE_TEMPLATE_PUBLISH_DATABASE_URL to the intended local Koed database"
    );
  }
  const target = new URL(connectionString);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)) {
    throw new Error("Role template publishing is limited to a local database");
  }
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const dirs = (await readdir(sourceRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => resolve(sourceRoot, entry.name))
      .sort();
    const templates = await Promise.all(dirs.map(loadTemplate));
    const published = await publishTemplates(pool, templates);
    process.stdout.write(`${JSON.stringify({ published }, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  });
}
