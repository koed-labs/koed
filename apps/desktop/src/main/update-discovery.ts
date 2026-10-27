import { z } from "zod";
import {
  desktopStableVersionPattern,
  desktopUpdateStateSchema,
  type DesktopUpdateState
} from "@koed/shared/desktop-update-contract";

export const updateNoticeEligible = (input: {
  packaged: boolean;
  platform: string;
  arch: string;
  argv: readonly string[];
}): boolean =>
  input.packaged &&
  input.platform === "darwin" &&
  input.arch === "arm64" &&
  !input.argv.includes("--koed-private-smoke");

export const desktopReleaseMetadataUrl =
  "https://api.github.com/repos/koed-labs/koed/releases?per_page=100&page=1";
const releaseListUrl = "https://api.github.com/repos/koed-labs/koed/releases";
const maximumPages = 10;
const pageSize = 100;
const maximumPageBytes = 2 * 1024 * 1024;
const maximumMetadataBytes = 10 * 1024 * 1024;
const maximumTimerDelay = 2_147_483_647;
const pageUrl = (page: number): string =>
  `${releaseListUrl}?per_page=${pageSize}&page=${page}`;
const stableVersion = z.string().max(64).regex(desktopStableVersionPattern);
const assetSchema = z.object({
  name: z.string(),
  state: z.literal("uploaded"),
  size: z.number().int().positive(),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  browser_download_url: z.string()
});
const releaseSchema = z.object({
  tag_name: z.string(),
  draft: z.literal(false),
  prerelease: z.literal(false),
  published_at: z.iso.datetime(),
  html_url: z.string(),
  body: z.string().nullable(),
  assets: z.array(z.unknown()).max(200)
});

export const officialReleasePage = (version: string): string =>
  `https://github.com/koed-labs/koed/releases/tag/v${stableVersion.parse(version)}`;

const newerVersion = (candidate: string, installed: string): boolean => {
  const left = candidate.split(".").map(BigInt);
  const right = installed.split(".").map(BigInt);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index]! > right[index]!;
  }
  return false;
};

const supportedAssets = (assets: unknown[], version: string): void => {
  for (const name of [
    `Koed-${version}-arm64.dmg`,
    "koed-desktop-macos-arm64.sha256"
  ]) {
    const matches = assets.filter(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        "name" in item &&
        item.name === name
    );
    if (matches.length !== 1)
      throw new Error("Supported manual release artifact missing.");
    const asset = assetSchema.parse(matches[0]);
    const expected = `https://github.com/koed-labs/koed/releases/download/v${version}/${name}`;
    if (asset.browser_download_url !== expected)
      throw new Error("Invalid release artifact destination.");
  }
};

const parseRelease = (
  value: unknown,
  installedVersion: string
): DesktopUpdateState["release"] => {
  const release = releaseSchema.parse(value);
  const version = stableVersion.parse(
    release.tag_name.startsWith("v") ? release.tag_name.slice(1) : ""
  );
  if (release.html_url !== officialReleasePage(version))
    throw new Error("Invalid official release page.");
  if (!newerVersion(version, installedVersion)) return null;
  supportedAssets(release.assets, version);
  return { version, summary: release.body?.slice(0, 4000) ?? "" };
};

class RateLimitError extends Error {
  constructor(readonly retryAt: number) {
    super("Official release metadata rate limited.");
  }
}

const rateLimitRetryAt = (response: Response): number => {
  const now = Date.now();
  const retry = response.headers.get("retry-after")?.trim();
  const reset = response.headers.get("x-ratelimit-reset")?.trim();
  const times: number[] = [];
  if (retry && /^\d+$/u.test(retry)) times.push(now + Number(retry) * 1000);
  else if (
    retry &&
    /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(
      retry
    )
  )
    times.push(Date.parse(retry));
  if (reset && /^\d+$/u.test(reset)) times.push(Number(reset) * 1000);
  const valid = times.filter((time) => !Number.isNaN(time) && time > now);
  const latest = valid.length ? Math.max(...valid) : now;
  return Number.isSafeInteger(latest) ? latest : Infinity;
};

const readBoundedJson = async (
  response: Response,
  expectedUrl: string,
  budget: { size: number }
): Promise<unknown> => {
  if (
    !response.redirected &&
    (!response.url || response.url === expectedUrl) &&
    (response.status === 403 || response.status === 429)
  ) {
    const retryAt = rateLimitRetryAt(response);
    await response.body?.cancel();
    throw new RateLimitError(retryAt);
  }
  if (
    !response.ok ||
    response.redirected ||
    (response.url && response.url !== expectedUrl)
  ) {
    await response.body?.cancel();
    throw new Error("Official release metadata unavailable.");
  }
  if (
    !response.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json") ||
    !response.body
  ) {
    await response.body?.cancel();
    throw new Error("Invalid release metadata response.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      budget.size += chunk.value.byteLength;
      if (size > maximumPageBytes || budget.size > maximumMetadataBytes)
        throw new Error("Release metadata too large.");
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    ) as unknown;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
};

const hasNextPage = (header: string | null, page: number): boolean => {
  if (header === null) return false;
  const relations = new Set<string>();
  for (const part of header.split(",")) {
    const match = /^\s*<([^>]+)>;\s*rel="(next|prev|first|last)"\s*$/u.exec(
      part
    );
    if (!match || relations.has(match[2]!))
      throw new Error("Invalid pagination.");
    const url = new URL(match[1]!);
    const target = Number(url.searchParams.get("page"));
    if (
      !Number.isSafeInteger(target) ||
      target < 1 ||
      (url.href !== pageUrl(target) &&
        !new RegExp(
          `^https://api\\.github\\.com/repositories/[1-9][0-9]*/releases\\?per_page=100&page=${target}$`,
          "u"
        ).test(url.href))
    )
      throw new Error("Invalid pagination.");
    const relation = match[2]!;
    if (
      (relation === "next" && target !== page + 1) ||
      (relation === "prev" && target !== page - 1) ||
      (relation === "first" && target !== 1) ||
      (relation === "last" && target < page)
    )
      throw new Error("Invalid pagination.");
    if (relation === "last" && target > page && !header.includes('rel="next"'))
      throw new Error("Incomplete pagination.");
    relations.add(relation);
  }
  return relations.has("next");
};

const listEntrySchema = z.object({
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean()
});

const findHighestRelease = async (
  fetcher: typeof globalThis.fetch,
  signal: AbortSignal
): Promise<unknown | null> => {
  const budget = { size: 0 };
  let highest: { version: string; value: unknown } | null = null;
  for (let page = 1; page <= maximumPages; page += 1) {
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
      .parse(await readBoundedJson(response, url, budget));
    for (const value of entries) {
      const entry = listEntrySchema.parse(value);
      if (entry.draft || entry.prerelease) continue;
      const version = entry.tag_name.startsWith("v")
        ? entry.tag_name.slice(1)
        : "";
      if (!stableVersion.safeParse(version).success) continue;
      if (!highest || newerVersion(version, highest.version))
        highest = { version, value };
      else if (version === highest.version)
        throw new Error("Duplicate release version.");
    }
    const next = hasNextPage(response.headers.get("link"), page);
    if (!next && entries.length < pageSize) {
      if (!highest) throw new Error("No stable release found.");
      return highest.value;
    }
  }
  throw new Error("Release pagination limit exceeded.");
};

interface DiscoveryOptions {
  eligible: boolean;
  installedVersion: string;
  fetch?: typeof globalThis.fetch;
  random?: () => number;
}

class UpdateDiscovery {
  private state: DesktopUpdateState;
  private listeners = new Set<(state: DesktopUpdateState) => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | undefined;
  private pending: Promise<DesktopUpdateState> | undefined;
  private disposed = false;
  private started = false;
  private nextAllowedAt = 0;
  private failures = 0;
  private readonly enabled: boolean;

  constructor(private readonly options: DiscoveryOptions) {
    this.enabled =
      options.eligible &&
      stableVersion.safeParse(options.installedVersion).success;
    this.state = desktopUpdateStateSchema.parse({
      installedVersion: options.installedVersion,
      status: this.enabled ? "idle" : "disabled",
      release: null,
      checkedAt: null
    });
  }

  current = (): DesktopUpdateState =>
    desktopUpdateStateSchema.parse(this.state);

  subscribe = (listener: (state: DesktopUpdateState) => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private publish(next: DesktopUpdateState): void {
    if (this.disposed) return;
    this.state = desktopUpdateStateSchema.parse(next);
    for (const listener of this.listeners) listener(this.current());
  }

  check = (): Promise<DesktopUpdateState> => {
    if (this.pending) return this.pending;
    if (this.disposed || !this.enabled || Date.now() < this.nextAllowedAt)
      return Promise.resolve(this.current());
    this.nextAllowedAt = Date.now() + 60_000;
    this.pending = this.performCheck().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  };

  private async performCheck(): Promise<DesktopUpdateState> {
    this.controller = new AbortController();
    const controller = this.controller;
    const deadline = setTimeout(() => controller.abort(), 10_000);
    this.publish({ ...this.state, status: "checking" });
    try {
      const highest = await findHighestRelease(
        this.options.fetch ?? globalThis.fetch,
        controller.signal
      );
      const release =
        highest === null
          ? null
          : parseRelease(highest, this.state.installedVersion);
      this.failures = 0;
      this.publish({
        ...this.state,
        release,
        status: release ? "available" : "current",
        checkedAt: new Date().toISOString()
      });
    } catch (error) {
      if (error instanceof RateLimitError)
        this.nextAllowedAt = Math.max(this.nextAllowedAt, error.retryAt);
      this.failures += 1;
      this.publish({
        ...this.state,
        release: null,
        status: "error",
        checkedAt: new Date().toISOString()
      });
    } finally {
      clearTimeout(deadline);
      this.controller = undefined;
    }
    return this.current();
  }

  start = (): void => {
    if (!this.enabled || this.started || this.disposed) return;
    this.started = true;
    this.schedule(5000);
  };

  private schedule(delay: number): void {
    this.timer = setTimeout(
      () => {
        if (Date.now() < this.nextAllowedAt) {
          if (this.nextAllowedAt !== Infinity)
            this.schedule(this.nextAllowedAt - Date.now());
          return;
        }
        void this.check().then(() => {
          if (this.disposed || this.nextAllowedAt === Infinity) return;
          const base = this.failures
            ? Math.min(
                6 * 3600_000,
                5 * 60_000 * 3 ** Math.min(this.failures - 1, 6)
              )
            : 6 * 3600_000;
          const random = Math.min(
            1,
            Math.max(0, (this.options.random ?? Math.random)())
          );
          this.schedule(
            Math.max(
              base * (0.8 + 0.4 * random),
              this.nextAllowedAt - Date.now()
            )
          );
        });
      },
      Math.min(delay, maximumTimerDelay)
    );
    this.timer.unref?.();
  }

  dispose = (): void => {
    this.disposed = true;
    clearTimeout(this.timer);
    this.controller?.abort();
    this.listeners.clear();
  };
}

export const createUpdateDiscovery = (options: DiscoveryOptions) =>
  new UpdateDiscovery(options);
export type DesktopUpdateDiscovery = ReturnType<typeof createUpdateDiscovery>;
