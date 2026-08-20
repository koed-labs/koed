import { randomUUID } from "node:crypto";
import {
  constants,
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink
} from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import { canonicalJson, sha256, type JsonValue } from "./core/hash.js";
import { assertEvalDatabaseName } from "./database-templates.js";

const ENTRY_SCHEMA = "koed-oracle-campaign-template-cache-v1";
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const noFollow = constants.O_NOFOLLOW ?? 0;

export type OracleCampaignTemplateIdentity = Readonly<
  Record<string, JsonValue>
>;

export interface OracleCampaignTemplateCacheEntry {
  schema: typeof ENTRY_SCHEMA;
  contentIdentity: string;
  identity: OracleCampaignTemplateIdentity;
  databaseName: string;
  template: JsonValue;
  frozen: { allowConnections: false; isTemplate: true };
  entryHash: string;
}

const contentIdentityFor = (identity: OracleCampaignTemplateIdentity): string =>
  `sha256:${sha256(canonicalJson(identity))}`;

export const oracleCampaignTemplateContentIdentity = contentIdentityFor;

const mode = (value: number): number => value & 0o777;

const inside = (parent: string, child: string): boolean => {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};

const assertNormalizedAbsolute = (path: string, label: string): void => {
  if (!isAbsolute(path) || normalize(path) !== path || resolve(path) !== path) {
    throw new Error(`${label} must be an absolute normalized path`);
  }
};

const ensureDirectoryWithoutSymlinks = async (path: string): Promise<void> => {
  const parts = path.split("/").filter(Boolean);
  let current = "/";
  for (const part of parts) {
    current = join(current, part);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error(
          `Template cache path component is not a real directory: ${current}`
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 });
      const stats = await lstat(current);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error(
          `Template cache path component changed during creation: ${current}`,
          { cause: error }
        );
      }
    }
  }
};

const entryBody = ({
  identity,
  databaseName,
  template
}: {
  identity: OracleCampaignTemplateIdentity;
  databaseName: string;
  template: JsonValue;
}) => ({
  schema: ENTRY_SCHEMA as typeof ENTRY_SCHEMA,
  contentIdentity: contentIdentityFor(identity),
  identity,
  databaseName,
  template,
  frozen: { allowConnections: false as const, isTemplate: true as const }
});

const makeEntry = (input: {
  identity: OracleCampaignTemplateIdentity;
  databaseName: string;
  template: JsonValue;
}): OracleCampaignTemplateCacheEntry => {
  assertEvalDatabaseName(input.databaseName);
  const body = entryBody(input);
  return { ...body, entryHash: `sha256:${sha256(canonicalJson(body))}` };
};

const parseEntry = (
  raw: string,
  expectedIdentity: OracleCampaignTemplateIdentity
): OracleCampaignTemplateCacheEntry => {
  if (Buffer.byteLength(raw) > MAX_ENTRY_BYTES) {
    throw new Error("Campaign template cache entry exceeds the size limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Campaign template cache entry is not valid JSON");
  }
  if (`${canonicalJson(parsed)}\n` !== raw) {
    throw new Error("Campaign template cache entry is not canonical JSON");
  }
  const value = parsed as Partial<OracleCampaignTemplateCacheEntry>;
  if (
    value.schema !== ENTRY_SCHEMA ||
    typeof value.databaseName !== "string" ||
    typeof value.contentIdentity !== "string" ||
    typeof value.entryHash !== "string" ||
    !value.template ||
    typeof value.template !== "object" ||
    !value.identity ||
    typeof value.identity !== "object" ||
    Array.isArray(value.identity) ||
    value.frozen?.allowConnections !== false ||
    value.frozen.isTemplate !== true
  ) {
    throw new Error("Campaign template cache entry has an invalid shape");
  }
  assertEvalDatabaseName(value.databaseName);
  const expectedContentIdentity = contentIdentityFor(expectedIdentity);
  if (
    value.contentIdentity !== expectedContentIdentity ||
    canonicalJson(value.identity) !== canonicalJson(expectedIdentity)
  ) {
    throw new Error("Campaign template cache content identity mismatch");
  }
  const expected = makeEntry({
    identity: value.identity,
    databaseName: value.databaseName,
    template: value.template as JsonValue
  });
  if (
    value.entryHash !== expected.entryHash ||
    canonicalJson(value) !== canonicalJson(expected)
  ) {
    throw new Error("Campaign template cache entry hash mismatch");
  }
  return value as OracleCampaignTemplateCacheEntry;
};

export class OracleCampaignTemplateCache {
  private constructor(
    readonly directory: string,
    private readonly repositoryRoot: string,
    private readonly rootIdentity: { dev: number; ino: number }
  ) {}

  static async open({
    cacheDirectory,
    repositoryRoot
  }: {
    cacheDirectory: string;
    repositoryRoot: string;
  }): Promise<OracleCampaignTemplateCache> {
    assertNormalizedAbsolute(
      cacheDirectory,
      "Campaign template cache directory"
    );
    assertNormalizedAbsolute(repositoryRoot, "Repository root");
    const repositoryReal = await realpath(repositoryRoot);
    if (inside(repositoryReal, cacheDirectory)) {
      throw new Error(
        "Campaign template cache directory must be outside the repository"
      );
    }
    await ensureDirectoryWithoutSymlinks(cacheDirectory);
    const cacheReal = await realpath(cacheDirectory);
    if (cacheReal !== cacheDirectory) {
      throw new Error("Campaign template cache directory contains a symlink");
    }
    if (inside(repositoryReal, cacheReal)) {
      throw new Error(
        "Campaign template cache directory must be outside the repository"
      );
    }
    const stats = await lstat(cacheDirectory);
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      mode(stats.mode) !== 0o700
    ) {
      throw new Error(
        "Campaign template cache directory must be a real 0700 directory"
      );
    }
    return new OracleCampaignTemplateCache(cacheDirectory, repositoryReal, {
      dev: stats.dev,
      ino: stats.ino
    });
  }

  entryPath(identity: OracleCampaignTemplateIdentity): string {
    const digest = contentIdentityFor(identity).slice("sha256:".length);
    return join(this.directory, `${digest}.json`);
  }

  private async assertRoot(): Promise<void> {
    const stats = await lstat(this.directory);
    const real = await realpath(this.directory);
    if (
      stats.isSymbolicLink() ||
      !stats.isDirectory() ||
      mode(stats.mode) !== 0o700 ||
      stats.dev !== this.rootIdentity.dev ||
      stats.ino !== this.rootIdentity.ino ||
      real !== this.directory ||
      inside(this.repositoryRoot, real)
    ) {
      throw new Error(
        "Campaign template cache directory changed after validation"
      );
    }
  }

  private async readPath(
    path: string,
    identity: OracleCampaignTemplateIdentity
  ): Promise<OracleCampaignTemplateCacheEntry> {
    const before = await lstat(path);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      mode(before.mode) !== 0o600
    ) {
      throw new Error("Campaign template cache entry must be a real 0600 file");
    }
    const handle = await open(path, constants.O_RDONLY | noFollow);
    try {
      const opened = await handle.stat();
      if (opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new Error("Campaign template cache entry changed while opening");
      }
      const raw = await handle.readFile({ encoding: "utf8" });
      const after = await lstat(path);
      if (opened.dev !== after.dev || opened.ino !== after.ino) {
        throw new Error("Campaign template cache entry changed while reading");
      }
      return parseEntry(raw, identity);
    } finally {
      await handle.close();
    }
  }

  async lookup(
    identity: OracleCampaignTemplateIdentity
  ): Promise<OracleCampaignTemplateCacheEntry | null> {
    await this.assertRoot();
    const path = this.entryPath(identity);
    try {
      return await this.readPath(path, identity);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async publish(input: {
    identity: OracleCampaignTemplateIdentity;
    databaseName: string;
    template: JsonValue;
  }): Promise<OracleCampaignTemplateCacheEntry> {
    await this.assertRoot();
    const entry = makeEntry(input);
    const serializedEntry = `${canonicalJson(entry)}\n`;
    if (Buffer.byteLength(serializedEntry) > MAX_ENTRY_BYTES) {
      throw new Error("Campaign template cache entry exceeds the size limit");
    }
    const destination = this.entryPath(input.identity);
    const temp = join(this.directory, `.${randomUUID()}.tmp`);
    const handle = await open(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600
    );
    try {
      await handle.writeFile(serializedEntry, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temp, destination);
      const directory = await open(this.directory, constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      return entry;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await this.readPath(destination, input.identity);
      if (
        existing.databaseName !== entry.databaseName ||
        existing.entryHash !== entry.entryHash
      ) {
        throw new Error("Campaign template cache publication collision", {
          cause: error
        });
      }
      return existing;
    } finally {
      await unlink(temp).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }

  async evict({
    identity,
    databaseName,
    entryHash
  }: {
    identity: OracleCampaignTemplateIdentity;
    databaseName: string;
    entryHash: string;
  }): Promise<void> {
    await this.assertRoot();
    const path = this.entryPath(identity);
    const current = await this.readPath(path, identity);
    if (
      current.databaseName !== databaseName ||
      current.entryHash !== entryHash
    ) {
      throw new Error("Campaign template cache eviction check failed");
    }
    const tombstone = join(this.directory, `.${randomUUID()}.evicting`);
    await rename(path, tombstone);
    try {
      const moved = await this.readPath(tombstone, identity);
      if (
        moved.databaseName !== databaseName ||
        moved.entryHash !== entryHash
      ) {
        throw new Error(
          "Campaign template cache entry changed during eviction"
        );
      }
      await unlink(tombstone);
      const directory = await open(this.directory, constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      await rename(tombstone, path).catch(() => undefined);
      throw error;
    }
  }
}
