import { watch, type FSWatcher } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";

export type KoedLocalWorkSignal = "lcm-summary";

const processLocalWatchers = new Map<string, Set<() => void>>();

const notifyProcessLocalWatchers = (file: string): void => {
  for (const wake of processLocalWatchers.get(file) ?? []) wake();
};

const signalDirectory = (koedHome: string): string =>
  path.join(path.resolve(koedHome), "runtime", "work-signals");

export const koedLocalWorkSignalPath = (
  koedHome: string,
  signal: KoedLocalWorkSignal
): string => path.join(signalDirectory(koedHome), `${signal}.pending`);

const ensureSignalDirectory = async (koedHome: string): Promise<string> => {
  const directory = signalDirectory(koedHome);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
};

export const requestKoedLocalWork = async (
  koedHome: string,
  signal: KoedLocalWorkSignal
): Promise<void> => {
  await ensureSignalDirectory(koedHome);
  const destination = koedLocalWorkSignalPath(koedHome, signal);
  try {
    await writeFile(
      destination,
      JSON.stringify({
        version: 1,
        signal,
        requestedAt: new Date().toISOString()
      }),
      { encoding: "utf8", mode: 0o600, flag: "wx" }
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  notifyProcessLocalWatchers(destination);
};

const claimSignal = async (file: string): Promise<string | null> => {
  let stat;
  try {
    stat = await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Koed local work signal is not a regular file");
  }
  const claimed = `${file}.processing.${process.pid}.${Date.now()}`;
  try {
    await rename(file, claimed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  await readFile(claimed, { encoding: "utf8" });
  return claimed;
};

export const watchKoedLocalWork = async (
  koedHome: string,
  signal: KoedLocalWorkSignal,
  onSignal: () => void | Promise<void>,
  onError: (error: unknown) => void = () => undefined
): Promise<{ stop(): void }> => {
  const directory = await ensureSignalDirectory(koedHome);
  const file = koedLocalWorkSignalPath(koedHome, signal);
  const filename = path.basename(file);
  const staleClaims = (await readdir(directory))
    .filter((entry) => entry.startsWith(`${filename}.processing.`))
    .map((entry) => path.join(directory, entry));
  let watcher: FSWatcher | null = null;
  let stopped = false;
  let draining = false;
  let requested = true;

  const drain = async (): Promise<void> => {
    if (draining || stopped) return;
    draining = true;
    try {
      while (!stopped) {
        requested = false;
        const currentClaim = await claimSignal(file);
        const claims = [
          ...staleClaims.splice(0),
          ...(currentClaim ? [currentClaim] : [])
        ].filter((claim): claim is string => Boolean(claim));
        if (claims.length === 0) {
          if (!requested) break;
          continue;
        }
        await onSignal();
        await Promise.all(claims.map((claim) => rm(claim, { force: true })));
      }
    } catch (error) {
      onError(error);
    } finally {
      draining = false;
      if (requested && !stopped) void drain();
    }
  };

  const wake = () => {
    requested = true;
    void drain();
  };

  watcher = watch(directory, { persistent: false }, (_event, changed) => {
    if (changed === filename) wake();
  });
  watcher.on("error", onError);
  const localWatchers = processLocalWatchers.get(file) ?? new Set<() => void>();
  localWatchers.add(wake);
  processLocalWatchers.set(file, localWatchers);
  void drain();

  return {
    stop() {
      stopped = true;
      localWatchers.delete(wake);
      if (localWatchers.size === 0) processLocalWatchers.delete(file);
      watcher?.close();
      watcher = null;
    }
  };
};
