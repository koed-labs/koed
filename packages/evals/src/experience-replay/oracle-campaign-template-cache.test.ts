import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "./core/hash.js";
import {
  OracleCampaignTemplateCache,
  oracleCampaignTemplateContentIdentity,
  type OracleCampaignTemplateIdentity
} from "./oracle-campaign-template-cache.js";

const roots: string[] = [];

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "koed-template-cache-test-"));
  roots.push(root);
  const directory = join(root, "cache");
  return {
    directory,
    cache: await OracleCampaignTemplateCache.open({
      cacheDirectory: directory,
      repositoryRoot: process.cwd()
    })
  };
};

const identity: OracleCampaignTemplateIdentity = {
  schema: "test-oracle-campaign-identity-v1",
  imageHash: `sha256:${"a".repeat(64)}`,
  campaignHash: `sha256:${"b".repeat(64)}`,
  sourceStateHash: `sha256:${"c".repeat(64)}`
};
const template = {
  templateId: "koed_eval_campaign_cached",
  sourceStateHash: `sha256:${"e".repeat(64)}`,
  attestation: { schema: "fixture-v1" }
} as const;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("oracle campaign template cache", () => {
  it("atomically publishes canonical 0600 entries in a private 0700 directory", async () => {
    const { cache, directory } = await fixture();
    const entry = await cache.publish({
      identity,
      databaseName: "koed_eval_campaign_cached",
      template
    });
    const path = cache.entryPath(identity);

    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, "utf8")).toBe(`${canonicalJson(entry)}\n`);
    await expect(cache.lookup(identity)).resolves.toEqual(entry);
    expect(entry.contentIdentity).toBe(
      oracleCampaignTemplateContentIdentity(identity)
    );
  });

  it("is idempotent for an exact publication and fails closed on collisions", async () => {
    const { cache } = await fixture();
    const first = await cache.publish({
      identity,
      databaseName: "koed_eval_campaign_cached",
      template
    });
    await expect(
      cache.publish({
        identity,
        databaseName: "koed_eval_campaign_cached",
        template
      })
    ).resolves.toEqual(first);
    await expect(
      cache.publish({
        identity,
        databaseName: "koed_eval_campaign_other",
        template
      })
    ).rejects.toThrow("publication collision");
  });

  it("round-trips multi-task metadata and rejects entries above the cache limit", async () => {
    const { cache } = await fixture();
    const largeTemplate = {
      ...template,
      metadata: "x".repeat(2 * 1024 * 1024)
    };
    const entry = await cache.publish({
      identity,
      databaseName: "koed_eval_campaign_cached",
      template: largeTemplate
    });
    await expect(cache.lookup(identity)).resolves.toEqual(entry);

    const oversizedIdentity = {
      ...identity,
      campaignHash: `sha256:${"d".repeat(64)}`
    };
    await expect(
      cache.publish({
        identity: oversizedIdentity,
        databaseName: "koed_eval_campaign_oversized",
        template: { ...template, metadata: "x".repeat(17 * 1024 * 1024) }
      })
    ).rejects.toThrow("exceeds the size limit");
    await expect(cache.lookup(oversizedIdentity)).resolves.toBeNull();
  });

  it("rejects noncanonical or permission-weakened entries", async () => {
    const { cache } = await fixture();
    const entry = await cache.publish({
      identity,
      databaseName: "koed_eval_campaign_cached",
      template
    });
    const path = cache.entryPath(identity);
    await writeFile(path, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
    await expect(cache.lookup(identity)).rejects.toThrow("not canonical JSON");
    await writeFile(path, `${canonicalJson(entry)}\n`, "utf8");
    await chmod(path, 0o644);
    await expect(cache.lookup(identity)).rejects.toThrow("real 0600 file");
  });

  it("requires exact checked eviction", async () => {
    const { cache } = await fixture();
    const entry = await cache.publish({
      identity,
      databaseName: "koed_eval_campaign_cached",
      template
    });
    await expect(
      cache.evict({ ...entry, entryHash: `sha256:${"0".repeat(64)}` })
    ).rejects.toThrow("eviction check failed");
    await cache.evict({
      identity,
      databaseName: entry.databaseName,
      entryHash: entry.entryHash
    });
    await expect(cache.lookup(identity)).resolves.toBeNull();
  });

  it("rejects cache paths inside the repository and paths with symlink components", async () => {
    const inside = join(process.cwd(), ".template-cache-test");
    await expect(
      OracleCampaignTemplateCache.open({
        cacheDirectory: inside,
        repositoryRoot: process.cwd()
      })
    ).rejects.toThrow("outside the repository");
    await rm(inside, { recursive: true, force: true });

    const root = await mkdtemp(
      join(tmpdir(), "koed-template-cache-link-test-")
    );
    roots.push(root);
    const target = join(root, "target");
    await symlink(tmpdir(), target);
    await expect(
      OracleCampaignTemplateCache.open({
        cacheDirectory: join(target, "cache"),
        repositoryRoot: process.cwd()
      })
    ).rejects.toThrow("not a real directory");
  });
});
