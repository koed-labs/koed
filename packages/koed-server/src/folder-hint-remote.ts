import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import type { AssociatedRepositorySelection } from "@koed-labs/shared";
import { z } from "zod";
import {
  folderHintFileMissing,
  inspectFolderHintFile
} from "./folder-hint-file.js";
import {
  parseGitProjectRemotes,
  readSelectedGitRemoteUrls
} from "./git-project-probe.js";
import type { KoedServerPaths } from "./paths.js";
import {
  resolveRepositoryRemote,
  validateSelectedRepositoryRemote
} from "./repository-identity.js";

const GIT_TIMEOUT_MS = 2_000;
const ASSOCIATION_TIMEOUT_MS = 2_000;
export const MAX_GIT_BYTES = 64 * 1024;
const MAX_PROJECT_METADATA_BYTES = 16 * 1024 * 1024;
const run = promisify(execFile);

export const readHintGit = async (
  directory: string,
  args: string[]
): Promise<string | null> => {
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    delete env.GIT_DIR;
    delete env.GIT_COMMON_DIR;
    delete env.GIT_WORK_TREE;
    const { stdout } = await run("git", ["-C", directory, ...args], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_GIT_BYTES,
      killSignal: "SIGKILL",
      env
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
};

export type HintAssociationLookup = (
  checkout: { originatingDeviceId: string; checkoutId: string },
  signal: AbortSignal
) => Promise<AssociatedRepositorySelection | undefined>;

const checkoutSelections = z.object({
  schemaVersion: z.literal(3),
  deviceSaltId: z.string().trim().min(1),
  checkouts: z.array(
    z.object({
      id: z.string(),
      root: z.string(),
      marker: z.string(),
      selectedRemote: z.string().optional(),
      associationLookupRequired: z.boolean().optional()
    })
  )
});

const readCheckoutSelection = async (
  paths: KoedServerPaths,
  root: string,
  marker: string
) => {
  const text = await inspectFolderHintFile(
    paths.projectMetadataPath,
    MAX_PROJECT_METADATA_BYTES
  );
  if (text === folderHintFileMissing)
    return { deviceSaltId: null, checkout: undefined };
  if (text === null) return null;
  try {
    const data = checkoutSelections.parse(JSON.parse(text));
    return {
      deviceSaltId: data.deviceSaltId,
      checkout: data.checkouts.find(
        (entry) => entry.root === root && entry.marker === marker
      )
    };
  } catch {
    return null;
  }
};

const checkoutStat = async (gitDir: string) => {
  const info = await stat(gitDir, { bigint: true }).catch(() => null);
  if (!info?.isDirectory()) return null;
  const { dev, ino, birthtimeNs, ctimeNs } = info;
  const birthtimeMs =
    Number(birthtimeNs / 1_000_000n) + Number(birthtimeNs % 1_000_000n) / 1e6;
  return {
    stamp: JSON.stringify([
      gitDir,
      String(dev),
      String(ino),
      String(birthtimeNs),
      // Without birthtime, ctime pins the current incarnation conservatively.
      ...(birthtimeNs <= 0n ? [String(ctimeNs)] : [])
    ]),
    // Keep the same marker format as capture for selecting the saved remote.
    marker: JSON.stringify([Number(dev), Number(ino), birthtimeMs]),
    birthtimeMs: birthtimeNs > 0n ? birthtimeMs : null,
    identifiable: dev >= 0n && ino > 0n && birthtimeNs > 0n,
    reviewable: dev >= 0n && ino > 0n && (birthtimeNs > 0n || ctimeNs > 0n)
  };
};

const lookupWithDeadline = async (
  lookup: HintAssociationLookup,
  checkout: Parameters<HintAssociationLookup>[0]
) => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("Hint association lookup timed out"));
      }, ASSOCIATION_TIMEOUT_MS);
    });
    return await Promise.race([lookup(checkout, controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
};

const checkoutPathsArgs = [
  "rev-parse",
  "--path-format=absolute",
  "--show-toplevel",
  "--absolute-git-dir",
  "--git-common-dir"
];

/** Observe only what portable selection needs; never initialize or lock the metadata store. */
export const readHintRemoteEvidence = async (
  paths: KoedServerPaths,
  directory: string,
  lookup?: HintAssociationLookup
): Promise<{
  fingerprint: string;
  gitDirectoryBirthtimeMs: number | null;
  gitCheckoutIncarnation?: string;
  manualGitCheckoutIncarnation?: string;
} | null> => {
  const gitPaths = await readHintGit(directory, checkoutPathsArgs);
  const entries = gitPaths?.split("\n");
  if (entries?.length !== 3 || !entries.every(isAbsolute)) return null;
  const [root, gitDir, commonDir] = entries as [string, string, string];
  const gitDirectory = await checkoutStat(gitDir);
  if (!gitDirectory) return null;
  const commonDirectory =
    commonDir === gitDir ? gitDirectory : await checkoutStat(commonDir);
  const { marker, stamp, identifiable, birthtimeMs } = gitDirectory;
  const saved = await readCheckoutSelection(paths, root, marker);
  if (!saved) return null;
  const { checkout, deviceSaltId } = saved;
  let associatedSelection: AssociatedRepositorySelection | undefined;
  if (
    checkout?.associationLookupRequired &&
    checkout.selectedRemote === undefined
  ) {
    if (!lookup || !deviceSaltId) return null;
    try {
      associatedSelection = await lookupWithDeadline(lookup, {
        originatingDeviceId: deviceSaltId,
        checkoutId: checkout.id
      });
    } catch {
      return null;
    }
    const current = await readCheckoutSelection(paths, root, marker);
    if (JSON.stringify(current) !== JSON.stringify(saved)) return null;
  }
  const { ambiguous, remotes } = parseGitProjectRemotes(
    await readHintGit(root, ["remote", "-v"])
  );
  if (ambiguous || !remotes.length) return null;
  const selection = resolveRepositoryRemote({
    observation: { status: "git", remotes },
    localSelection: checkout?.selectedRemote,
    associatedSelection
  });
  if (selection.state !== "selected") return null;
  const urls = await readSelectedGitRemoteUrls(selection.remote.name, (args) =>
    readHintGit(root, args)
  );
  if (validateSelectedRepositoryRemote(selection.remote, urls)) return null;
  // Recheck both paths and identities: either directory can be repointed or replaced.
  if (
    (await readHintGit(directory, checkoutPathsArgs)) !== gitPaths ||
    (await checkoutStat(gitDir))?.stamp !== stamp ||
    (commonDir !== gitDir &&
      (await checkoutStat(commonDir))?.stamp !== commonDirectory?.stamp)
  )
    return null;
  return {
    fingerprint: selection.remote.fingerprint,
    gitDirectoryBirthtimeMs: birthtimeMs,
    ...(identifiable && commonDirectory?.identifiable
      ? {
          gitCheckoutIncarnation: JSON.stringify([stamp, commonDirectory.stamp])
        }
      : gitDirectory.reviewable && commonDirectory?.reviewable
        ? {
            manualGitCheckoutIncarnation: JSON.stringify([
              stamp,
              commonDirectory.stamp
            ])
          }
        : {})
  };
};
