import { createWriteStream, rmSync } from "node:fs";
import { basename } from "node:path";
import { Readable, Transform } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";

export type DownloadProgress = (event: {
  phase: string;
  transferredBytes: number;
  totalBytes?: number;
}) => void;
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 30_000;
const cancelBody = async (response: Response): Promise<void> => {
  try {
    await response.body?.cancel();
  } catch {
    // Response cleanup is best-effort after a rejected transfer.
  }
};
export async function fetchBounded(
  urlText: string,
  destination: string,
  limit: number,
  signal: AbortSignal | undefined,
  progress?: DownloadProgress,
  collectBytes = true,
  attempt = 0
): Promise<Buffer | undefined> {
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    throw new Error("component source URL is invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("component downloads require safe HTTPS URLs");
  for (let redirects = 0; ; redirects++) {
    if (signal?.aborted) throw new Error("component installation cancelled");
    let response: Response;
    const timeoutController = new AbortController();
    const requestSignal = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal;
    let timeout = setTimeout(
      () => timeoutController.abort(),
      REQUEST_TIMEOUT_MS
    );
    const resetIdleTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => timeoutController.abort(), REQUEST_TIMEOUT_MS);
    };
    try {
      response = await fetch(url, {
        redirect: "manual",
        signal: requestSignal
      });
    } catch (error) {
      if (signal?.aborted)
        throw new Error("component installation cancelled", { cause: error });
      if (attempt < 2 && error instanceof TypeError) {
        await new Promise((resolveRetry) =>
          setTimeout(resolveRetry, 100 * (attempt + 1))
        );
        return fetchBounded(
          url.href,
          destination,
          limit,
          signal,
          progress,
          collectBytes,
          attempt + 1
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    if (response.status >= 500 && attempt < 2) {
      await cancelBody(response);
      await new Promise((resolveRetry) =>
        setTimeout(resolveRetry, 100 * (attempt + 1))
      );
      return fetchBounded(
        url.href,
        destination,
        limit,
        signal,
        progress,
        collectBytes,
        attempt + 1
      );
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects >= MAX_REDIRECTS) {
        await cancelBody(response);
        throw new Error("too many component redirects");
      }
      const location = response.headers.get("location");
      if (!location) {
        await cancelBody(response);
        throw new Error("component redirect has no location");
      }
      try {
        url = new URL(location, url);
      } catch {
        await cancelBody(response);
        throw new Error("component redirect URL is invalid");
      }
      if (url.protocol !== "https:" || url.username || url.password) {
        await cancelBody(response);
        throw new Error("component redirect requires safe HTTPS");
      }
      await cancelBody(response);
      continue;
    }
    if (!response.ok || !response.body) {
      await cancelBody(response);
      throw new Error(`component download failed with HTTP ${response.status}`);
    }
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > limit) {
      await cancelBody(response);
      throw new Error("component download exceeds size limit");
    }
    let transferredBytes = 0;
    const chunks: Buffer[] = [];
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        resetIdleTimeout();
        transferredBytes += chunk.length;
        if (transferredBytes > limit) {
          callback(new Error("component download exceeds size limit"));
          return;
        }
        progress?.({
          phase: basename(destination),
          transferredBytes,
          ...(Number.isFinite(length) && length > 0
            ? { totalBytes: length }
            : {})
        });
        if (collectBytes) chunks.push(Buffer.from(chunk));
        callback(null, chunk);
      }
    });
    const output = createWriteStream(destination, { flags: "wx", mode: 0o600 });
    resetIdleTimeout();
    try {
      await pipeline(
        Readable.fromWeb(
          response.body as unknown as NodeReadableStream<Uint8Array>
        ),
        limiter,
        output,
        { signal: requestSignal }
      );
    } catch (error) {
      rmSync(destination, { force: true });
      if (signal?.aborted)
        throw new Error("component installation cancelled", { cause: error });
      if (attempt < 2 && error instanceof TypeError) {
        await new Promise((resolveRetry) =>
          setTimeout(resolveRetry, 100 * (attempt + 1))
        );
        return fetchBounded(
          url.href,
          destination,
          limit,
          signal,
          progress,
          collectBytes,
          attempt + 1
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    return collectBytes ? Buffer.concat(chunks) : undefined;
  }
}
