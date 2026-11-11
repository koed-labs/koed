import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const drizzleDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../drizzle"
);

const readDrizzleFile = (path: string) =>
  readFile(resolve(drizzleDir, path), "utf8");

describe("fresh-install migration baseline", () => {
  it("contains exactly one clean initial migration", async () => {
    const [journalText, baselineSql] = await Promise.all([
      readDrizzleFile("meta/_journal.json"),
      readDrizzleFile("0000_clean_initial_schema.sql")
    ]);
    const journal = JSON.parse(journalText) as {
      entries: Array<{ idx: number; tag: string }>;
    };

    expect(journal.entries).toHaveLength(1);
    expect(journal.entries[0]).toMatchObject({
      idx: 0,
      tag: "0000_clean_initial_schema"
    });
    expect(baselineSql).not.toMatch(/DROP SCHEMA\s+public\s+CASCADE/i);
    const insertedTables = new Set(
      [...baselineSql.matchAll(/INSERT INTO public\.([a-z_]+)/gi)].map(
        (match) => match[1]
      )
    );
    expect([...insertedTables].sort()).toEqual(
      [
        "conversation_presentation_policy_rules",
        "conversation_presentation_policy_state",
        "projection_policy_rules",
        "projection_policy_state"
      ].sort()
    );
    expect(baselineSql).toContain("CREATE EXTENSION IF NOT EXISTS vector");
    expect(baselineSql).toMatch(/CREATE (OR REPLACE )?FUNCTION/);
    expect(baselineSql).toContain("CREATE TRIGGER");
    expect(baselineSql).toContain("INSERT INTO public.projection_policy_rules");
    expect(baselineSql).toContain(
      "INSERT INTO public.conversation_presentation_policy_rules"
    );
  });
});
