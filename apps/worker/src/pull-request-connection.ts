import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  writeFile
} from "node:fs/promises";
import { resolve, sep } from "node:path";
export type PullRequestConnection = {
  version: 1;
  ownerUserId: string;
  authorityId: string;
  generation: number;
  account: { id: string; login: string } | null;
};
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const parseConnection = (value: unknown): PullRequestConnection => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("PullRequestConnectionStoreInvalid");
  const data = value as Record<string, unknown>,
    account = data.account;
  if (
    data.version !== 1 ||
    typeof data.ownerUserId !== "string" ||
    !uuid.test(data.ownerUserId) ||
    typeof data.authorityId !== "string" ||
    !data.authorityId.length ||
    data.authorityId.length > 240 ||
    typeof data.generation !== "number" ||
    !Number.isSafeInteger(data.generation) ||
    data.generation < 1
  )
    throw new Error("PullRequestConnectionStoreInvalid");
  if (account !== null) {
    if (!account || typeof account !== "object" || Array.isArray(account))
      throw new Error("PullRequestConnectionStoreInvalid");
    const a = account as Record<string, unknown>;
    if (
      typeof a.id !== "string" ||
      !a.id.length ||
      a.id.length > 200 ||
      typeof a.login !== "string" ||
      !/^[A-Za-z0-9-]{1,39}$/.test(a.login)
    )
      throw new Error("PullRequestConnectionStoreInvalid");
  }
  return {
    version: 1,
    ownerUserId: data.ownerUserId,
    authorityId: data.authorityId,
    generation: data.generation,
    account: account as PullRequestConnection["account"]
  };
};
export const createPullRequestConnectionStore = (
  koedHome: string,
  authorityId: string
) => {
  const pathFor = async (ownerUserId: string) => {
    if (!uuid.test(ownerUserId))
      throw new Error("PullRequestConnectionStoreInvalid");
    const home = await realpath(koedHome);
    const directory = resolve(home, "managed-pull-requests", "connections");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (
      (await lstat(directory)).isSymbolicLink() ||
      !(await realpath(directory)).startsWith(`${home}${sep}`)
    )
      throw new Error("PullRequestConnectionStoreInvalid");
    return resolve(
      directory,
      `${createHash("sha256").update(`${authorityId}:${ownerUserId}`).digest("hex")}.json`
    );
  };
  const read = async (ownerUserId: string): Promise<PullRequestConnection> => {
    const path = await pathFor(ownerUserId);
    const stat = await lstat(path).catch(() => null);
    if (!stat)
      return {
        version: 1,
        ownerUserId,
        authorityId,
        generation: 1,
        account: null
      };
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192)
      throw new Error("PullRequestConnectionStoreInvalid");
    const result = parseConnection(JSON.parse(await readFile(path, "utf8")));
    if (
      result.ownerUserId !== ownerUserId ||
      result.authorityId !== authorityId
    )
      throw new Error("PullRequestConnectionStoreInvalid");
    return result;
  };
  return {
    read,
    async select(
      ownerUserId: string,
      account: PullRequestConnection["account"]
    ) {
      const current = await read(ownerUserId);
      const next = parseConnection({
        ...current,
        account,
        generation: current.generation + 1
      });
      const path = await pathFor(ownerUserId),
        temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(next), {
        mode: 0o600,
        flag: "wx"
      });
      await rename(temporary, path);
      return next;
    }
  };
};
