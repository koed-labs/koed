import { z } from "zod";
import {
  desktopStableVersionPattern,
  desktopUpdateStateSchema,
  type DesktopUpdateState
} from "@koed/shared/desktop-update-contract";

export interface DiscoveryOptions {
  eligible: boolean;
  installedVersion: string;
  fetch?: typeof globalThis.fetch;
  random?: () => number;
}

export interface DesktopUpdateDiscovery {
  current(): DesktopUpdateState;
  subscribe(listener: (state: DesktopUpdateState) => void): () => void;
  check(): Promise<DesktopUpdateState>;
  start(): void;
  dispose(): void;
}

const maxPages = 10;
const maxPageBytes = 2 * 1024 * 1024;
const maxScanBytes = 10 * 1024 * 1024;
const pageSize = 100;
const timeoutMs = 10_000;
const timerLimit = 2_147_483_647;
const apiUrl = "https://api.github.com/repos/koed-labs/koed/releases";
const versionSchema = z.string().max(64).regex(desktopStableVersionPattern);
const pageUrl = (page: number) => `${apiUrl}?per_page=${pageSize}&page=${page}`;

export const officialReleasePage = (version: string): string =>
  `https://github.com/koed-labs/koed/releases/tag/v${versionSchema.parse(version)}`;

const isNewer = (left: string, right: string): boolean => {
  const a = left.split(".").map(BigInt);
  const b = right.split(".").map(BigInt);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index]! > b[index]!;
  }
  return false;
};

const releaseSchema = z.object({
  tag_name: z.string(),
  draft: z.literal(false),
  prerelease: z.literal(false),
  html_url: z.string(),
  body: z.string().nullable(),
  assets: z.array(z.unknown()).max(200)
});
const assetSchema = z.object({
  name: z.string(),
  state: z.literal("uploaded"),
  size: z.number().int().positive(),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  browser_download_url: z.string()
});

const verifyAssets = (assets: unknown[], version: string) => {
  for (const name of [
    `Koed-${version}-arm64.dmg`,
    "koed-desktop-macos-arm64.sha256"
  ]) {
    const matches = assets.filter(
      (asset) =>
        typeof asset === "object" &&
        asset !== null &&
        "name" in asset &&
        asset.name === name
    );
    if (matches.length !== 1)
      throw new Error("Supported manual release artifact missing.");
    const parsed = assetSchema.parse(matches[0]);
    const expected = `https://github.com/koed-labs/koed/releases/download/v${version}/${name}`;
    if (parsed.browser_download_url !== expected)
      throw new Error("Invalid release artifact destination.");
  }
};

const cancelResponseBody = (response: Response): void => {
  const cancellation = response.body?.cancel();
  void cancellation?.catch((error: unknown) => {
    console.error("Desktop update response body cancellation failed.", error);
  });
};

const readJson = async (
  response: Response,
  expectedUrl: string,
  budget: { bytes: number }
): Promise<unknown> => {
  if (
    !response.ok ||
    response.redirected ||
    (response.url && response.url !== expectedUrl)
  ) {
    cancelResponseBody(response);
    throw new Error("Official release metadata unavailable.");
  }
  if (
    !response.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json") ||
    !response.body
  ) {
    cancelResponseBody(response);
    throw new Error("Invalid release metadata response.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      budget.bytes += part.value.byteLength;
      if (bytes > maxPageBytes || budget.bytes > maxScanBytes)
        throw new Error("Release metadata too large.");
      chunks.push(part.value);
    }
    const content = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      content.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(content)
    ) as unknown;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
};

const paginationNext = (
  link: string | null,
  page: number
): { hasNext: boolean; lastPage?: number } => {
  if (!link) return { hasNext: false };
  const relations = new Map<string, number>();
  for (const part of link.split(",")) {
    const match = /^\s*<([^>]+)>;\s*rel="(next|prev|first|last)"\s*$/u.exec(
      part
    );
    if (!match || relations.has(match[2]!))
      throw new Error("Invalid pagination.");
    let url: URL;
    try {
      url = new URL(match[1]!);
    } catch {
      throw new Error("Invalid pagination.");
    }
    const target = Number(url.searchParams.get("page"));
    if (url.href !== pageUrl(target) || !Number.isSafeInteger(target))
      throw new Error("Invalid pagination.");
    if (
      (match[2] === "next" && target !== page + 1) ||
      (match[2] === "prev" && target !== page - 1) ||
      (match[2] === "first" && target !== 1) ||
      (match[2] === "last" && target < page)
    )
      throw new Error("Invalid pagination.");
    relations.set(match[2]!, target);
  }
  const hasNext = relations.has("next");
  const lastPage = relations.get("last");
  if (
    lastPage !== undefined &&
    ((lastPage > page && !hasNext) || (hasNext && lastPage < page + 1))
  )
    throw new Error("Inconsistent pagination.");
  return { hasNext, ...(lastPage === undefined ? {} : { lastPage }) };
};

const discover = async (fetcher: typeof fetch, signal: AbortSignal) => {
  const budget = { bytes: 0 };
  let highest: { version: string; release: unknown } | undefined;
  let expectedLastPage: number | undefined;
  for (let page = 1; page <= maxPages; page += 1) {
    const url = pageUrl(page);
    const response = await fetcher(url, {
      signal,
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
      }
    });
    const entries = z
      .array(z.unknown())
      .max(pageSize)
      .parse(await readJson(response, url, budget));
    for (const value of entries) {
      const entry = z
        .object({
          tag_name: z.string(),
          draft: z.boolean(),
          prerelease: z.boolean()
        })
        .parse(value);
      if (entry.draft || entry.prerelease) continue;
      const candidate = entry.tag_name.startsWith("v")
        ? entry.tag_name.slice(1)
        : "";
      if (!versionSchema.safeParse(candidate).success) continue;
      if (!highest || isNewer(candidate, highest.version))
        highest = { version: candidate, release: value };
      else if (candidate === highest.version)
        throw new Error("Duplicate release version.");
    }
    const pagination = paginationNext(response.headers.get("link"), page);
    if (pagination.lastPage !== undefined) {
      if (
        expectedLastPage !== undefined &&
        pagination.lastPage !== expectedLastPage
      )
        throw new Error("Inconsistent pagination.");
      expectedLastPage = pagination.lastPage;
    }
    if (
      expectedLastPage !== undefined &&
      expectedLastPage > page &&
      !pagination.hasNext
    )
      throw new Error("Incomplete pagination.");
    if (!pagination.hasNext && entries.length < pageSize)
      return highest?.release ?? null;
  }
  throw new Error("Release pagination limit exceeded.");
};

export const createUpdateDiscovery = (
  options: DiscoveryOptions
): DesktopUpdateDiscovery => {
  const enabled =
    options.eligible &&
    versionSchema.safeParse(options.installedVersion).success;
  const initial = desktopUpdateStateSchema.parse({
    installedVersion: options.installedVersion,
    status: enabled ? "idle" : "disabled",
    release: null,
    checkedAt: null
  });
  let state = initial;
  let pending: Promise<DesktopUpdateState> | undefined;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let started = false;
  let allowedAt = 0;
  let failures = 0;
  const listeners = new Set<(state: DesktopUpdateState) => void>();
  const current = () => desktopUpdateStateSchema.parse(state);
  const publish = (next: DesktopUpdateState) => {
    if (disposed) return;
    state = desktopUpdateStateSchema.parse(next);
    for (const listener of listeners) {
      try {
        listener(current());
      } catch (error) {
        console.error("Desktop update state listener failed.", error);
      }
    }
  };
  const check = (): Promise<DesktopUpdateState> => {
    if (pending) return pending;
    if (disposed || !enabled || Date.now() < allowedAt)
      return Promise.resolve(current());
    allowedAt = Date.now() + 60_000;
    pending = (async () => {
      controller = new AbortController();
      const activeController = controller;
      const deadline = setTimeout(() => activeController.abort(), timeoutMs);
      try {
        publish({ ...state, status: "checking" });
        const releaseData = await discover(
          options.fetch ?? globalThis.fetch,
          activeController.signal
        );
        let release: DesktopUpdateState["release"] = null;
        if (releaseData !== null) {
          const result = releaseSchema.parse(releaseData);
          const version = versionSchema.parse(
            result.tag_name.startsWith("v") ? result.tag_name.slice(1) : ""
          );
          if (result.html_url !== officialReleasePage(version))
            throw new Error("Invalid official release page.");
          if (isNewer(version, options.installedVersion)) {
            verifyAssets(result.assets, version);
            release = { version, summary: result.body?.slice(0, 4_000) ?? "" };
          }
        }
        failures = 0;
        publish({
          ...state,
          release,
          status: release ? "available" : "current",
          checkedAt: new Date().toISOString()
        });
      } catch {
        failures += 1;
        publish({
          ...state,
          release: null,
          status: "error",
          checkedAt: new Date().toISOString()
        });
      } finally {
        clearTimeout(deadline);
        activeController.abort();
        controller = undefined;
      }
      return current();
    })().finally(() => {
      pending = undefined;
    });
    return pending;
  };
  const schedule = (delay: number) => {
    timer = setTimeout(
      () => {
        if (Date.now() < allowedAt) {
          schedule(allowedAt - Date.now());
          return;
        }
        const scheduleNext = () => {
          if (disposed) return;
          const base = failures
            ? Math.min(
                6 * 3_600_000,
                5 * 60_000 * 3 ** Math.min(failures - 1, 6)
              )
            : 6 * 3_600_000;
          const jitter = Math.max(
            0,
            Math.min(1, (options.random ?? Math.random)())
          );
          schedule(
            Math.max(base * (0.8 + 0.4 * jitter), allowedAt - Date.now())
          );
        };
        void check().then(scheduleNext, (error: unknown) => {
          console.error("Scheduled desktop update check failed.", error);
          failures += 1;
          scheduleNext();
        });
      },
      Math.min(delay, timerLimit)
    );
    timer.unref?.();
  };
  return {
    current,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    check,
    start() {
      if (!enabled || started || disposed) return;
      started = true;
      schedule(5_000);
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      controller?.abort();
      listeners.clear();
    }
  };
};
