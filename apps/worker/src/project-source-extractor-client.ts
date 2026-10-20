import { Worker } from "node:worker_threads";
import {
  ProjectSourceExtractionError,
  type ProjectSourceExtractionFailure
} from "./project-source-extraction-contract.js";

const MAX_EXTRACT_MILLISECONDS = 30_000;
const reasons = new Set<ProjectSourceExtractionFailure>([
  "unsupported_type",
  "too_large",
  "no_text_layer",
  "parse_error"
]);

export const extractProjectSourceTextBounded = (input: {
  name: string;
  bytes: Buffer;
}): Promise<string> =>
  new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL(
        import.meta.resolve("@koed/worker/project-source-extractor-thread")
      ),
      { execArgv: [] }
    );
    let settled = false;
    const finish = (result: { text?: string; error?: Error }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      void worker.terminate();
      if (result.error) reject(result.error);
      else resolve(result.text!);
    };
    const timeout = setTimeout(
      () => finish({ error: new ProjectSourceExtractionError("parse_error") }),
      MAX_EXTRACT_MILLISECONDS
    );
    worker.once("message", (message: unknown) => {
      if (
        message &&
        typeof message === "object" &&
        "ok" in message &&
        message.ok === true &&
        "text" in message &&
        typeof message.text === "string"
      ) {
        finish({ text: message.text });
        return;
      }
      const reason =
        message &&
        typeof message === "object" &&
        "reason" in message &&
        reasons.has(message.reason as ProjectSourceExtractionFailure)
          ? (message.reason as ProjectSourceExtractionFailure)
          : "parse_error";
      finish({ error: new ProjectSourceExtractionError(reason) });
    });
    worker.once("error", () =>
      finish({ error: new ProjectSourceExtractionError("parse_error") })
    );
    worker.once("exit", () => {
      if (!settled)
        finish({ error: new ProjectSourceExtractionError("parse_error") });
    });
    worker.postMessage({ name: input.name, bytes: input.bytes });
  });
