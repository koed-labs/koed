import { parentPort } from "node:worker_threads";
import {
  extractProjectSourceText,
  ProjectSourceExtractionError
} from "./project-source-extractor.js";

if (!parentPort)
  throw new Error("Project Source extractor needs a parent port");
const handleMessage = async (input: {
  name: string;
  bytes: Uint8Array;
}): Promise<void> => {
  try {
    const text = await extractProjectSourceText({
      name: input.name,
      bytes: Buffer.from(input.bytes)
    });
    parentPort!.postMessage({ ok: true, text });
  } catch (error) {
    parentPort!.postMessage({
      ok: false,
      reason:
        error instanceof ProjectSourceExtractionError
          ? error.reason
          : "parse_error"
    });
  }
};
parentPort.once("message", (input: { name: string; bytes: Uint8Array }) => {
  void handleMessage(input).catch(() => {
    parentPort!.postMessage({ ok: false, reason: "parse_error" });
  });
});
