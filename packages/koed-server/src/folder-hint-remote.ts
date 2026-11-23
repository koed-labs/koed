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

const checkoutMarker = async (gitDir: string) => {
  const info = await stat(gitDir).catch(() => null);
  // Match the checkout incarnation recorded by capture, not merely its path.
  return info ? JSON.stringify([info.dev, info.ino, info.birthtimeMs]) : null;
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

/** Observe only what portable selection needs; never initialize or lock the metadata store. */
export const readHintRemoteFingerprint = async (
  paths: KoedServerPaths,
  directory: string,
  lookup?: HintAssociationLookup
): Promise<string | null> => {
  const gitPaths = await readHintGit(directory, [
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
    "--absolute-git-dir",
    "--git-common-dir"
  ]);
  const entries = gitPaths?.split("\n");
  if (entries?.length !== 3 || !entries.every(isAbsolute)) return null;
  const [root, gitDir] = entries as [string, string, string];
  const marker = await checkoutMarker(gitDir);
  if (!marker) return null;
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
  return (await checkoutMarker(gitDir)) === marker
    ? selection.remote.fingerprint
    : null;
};
