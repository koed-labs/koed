import { z } from "zod";
import {
  PRIVACY_WINDOW_CORE_TOKENS,
  type PrivacyClassificationFieldRequest
} from "./privacy-filter-contract.js";

export const PRIVACY_CLASSIFICATION_STREAM_TYPE =
  "application/vnd.koed.privacy.v1+ndjson";

const frameSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("progress"),
      completedUnits: z.number().int().positive()
    })
    .strict(),
  z
    .object({
      type: z.literal("result"),
      status: z.number().int().min(200).max(599),
      retryAfter: z.boolean(),
      body: z.unknown()
    })
    .strict()
]);

export class PrivacyClassificationTransportError extends Error {}

/** A progress deadline advances only after a validated, finite unit of work. */
export const requestPrivacyClassification = async (input: {
  fetchImpl: typeof fetch;
  url: string;
  token: string;
  requestId: string;
  body: string;
  fields: readonly PrivacyClassificationFieldRequest[];
  timeoutMs: number;
}): Promise<{ status: number; retryAfter: boolean; body: unknown }> => {
  const cancellation = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const renew = (): void => {
    clearTimeout(timer);
    timer = setTimeout(
      () =>
        cancellation.abort(
          new DOMException("Privacy classification stalled", "TimeoutError")
        ),
      input.timeoutMs
    );
    timer.unref?.();
  };
  const bytes = input.fields.reduce(
    (total, field) => total + Buffer.byteLength(field.text, "utf8"),
    0
  );
  // The tokenizer has no normalizer: tokens cannot exceed UTF-8 input bytes.
  // Include field completions and one possible accelerator-to-CPU retry.
  const maximumUnits =
    2 *
    input.fields.reduce(
      (total, field) =>
        total +
        1 +
        Math.ceil(
          Buffer.byteLength(field.text, "utf8") / PRIVACY_WINDOW_CORE_TOKENS
        ),
      0
    );
  const maximumFrameBytes = bytes * 256 + input.fields.length * 2048 + 4096;
  renew();
  try {
    const response = await input.fetchImpl(input.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: PRIVACY_CLASSIFICATION_STREAM_TYPE,
        "x-koed-privacy-token": input.token,
        "x-request-id": input.requestId
      },
      body: input.body,
      signal: cancellation.signal
    });
    cancellation.signal.throwIfAborted();
    if (
      response.headers.get("content-type")?.split(";", 1)[0] !==
      PRIVACY_CLASSIFICATION_STREAM_TYPE
    ) {
      if (!response.ok) {
        await response.body?.cancel();
        return {
          status: response.status,
          retryAfter: response.headers.has("retry-after"),
          body: null
        };
      }
      return {
        status: response.status,
        retryAfter: response.headers.has("retry-after"),
        body: await response.json()
      };
    }
    if (!response.ok || !response.body)
      throw new PrivacyClassificationTransportError();
    const reader = response.body.getReader();
    cancellation.signal.addEventListener(
      "abort",
      () => {
        void reader.cancel().catch(() => undefined);
      },
      { once: true }
    );
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let pending = "";
    let completedUnits = 0;
    for (;;) {
      const chunk = await reader.read();
      cancellation.signal.throwIfAborted();
      try {
        pending += decoder.decode(chunk.value, { stream: !chunk.done });
      } catch {
        throw new PrivacyClassificationTransportError();
      }
      if (Buffer.byteLength(pending, "utf8") > maximumFrameBytes)
        throw new PrivacyClassificationTransportError();
      let newline: number;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          throw new PrivacyClassificationTransportError();
        }
        const parsed = frameSchema.safeParse(value);
        if (!parsed.success) throw new PrivacyClassificationTransportError();
        const frame = parsed.data;
        if (frame.type === "result") {
          if (pending.trim()) throw new PrivacyClassificationTransportError();
          await reader.cancel();
          return frame;
        }
        if (
          frame.completedUnits !== completedUnits + 1 ||
          frame.completedUnits > maximumUnits
        )
          throw new PrivacyClassificationTransportError();
        completedUnits = frame.completedUnits;
        renew();
      }
      if (chunk.done) throw new PrivacyClassificationTransportError();
    }
  } catch (error) {
    // Fetch body readers may report AbortError instead of the timeout reason.
    // Preserve the reason so durable callers never immediately retry a timeout.
    if (cancellation.signal.aborted) throw cancellation.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer!);
    cancellation.abort();
  }
};
