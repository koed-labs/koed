import { connect } from "node:net";
import type { Readable, Writable } from "node:stream";

const maximumBridgeBytes = 2_100_000;

const readPutValue = async (stdin: Readable): Promise<string> => {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stdin) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += value.byteLength;
    if (length > maximumBridgeBytes) throw new Error("Secret is too large.");
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
};

export const runPdsSecretBridgeClient = async (input: {
  operation: "get" | "put" | "delete";
  reference: string;
  socketPath: string;
  token: string;
  stdin: Readable;
  stdout: Writable;
}): Promise<boolean> => {
  const value =
    input.operation === "put" ? await readPutValue(input.stdin) : undefined;
  const request = {
    token: input.token,
    operation: input.operation,
    reference: input.reference,
    ...(value === undefined ? {} : { value })
  };
  return await new Promise<boolean>((resolvePromise) => {
    const socket = connect(input.socketPath);
    let response = "";
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise(ok);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(10_000, () => finish(false));
    socket.on("connect", () => socket.end(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      response += chunk;
      if (Buffer.byteLength(response, "utf8") > maximumBridgeBytes) {
        finish(false);
      }
    });
    socket.on("end", () => {
      try {
        const parsed = JSON.parse(response) as {
          ok?: unknown;
          value?: unknown;
        };
        if (parsed.ok !== true) return finish(false);
        if (input.operation === "get") {
          if (typeof parsed.value === "string") {
            input.stdout.write(parsed.value);
          } else if (parsed.value !== null) {
            return finish(false);
          }
        }
        finish(true);
      } catch {
        finish(false);
      }
    });
    socket.on("error", () => finish(false));
  });
};
