/* global fetch */
import { readFileSync } from "node:fs";
import process from "node:process";
import { Type } from "typebox";

export default function structuredResult(pi) {
  const schemaPath = process.env.KOED_PI_RESULT_SCHEMA;
  if (!schemaPath) throw new Error("KOED_PI_RESULT_SCHEMA is required");
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const bridge = process.env.KOED_PI_WORKER_TOOLS
    ? JSON.parse(readFileSync(process.env.KOED_PI_WORKER_TOOLS, "utf8"))
    : null;
  const call = async (name, value, signal) => {
    if (!bridge) throw new Error("Koed worker tool bridge is required");
    const response = await fetch(bridge.url, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        authorization: bridge.authorization
      },
      body: JSON.stringify({ name, value }),
      signal
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(result.error ?? "Koed worker validation failed");
    return result;
  };
  for (const tool of bridge?.tools ?? []) {
    pi.registerTool({
      name: tool.wireName,
      label: tool.wireName,
      description: tool.description,
      parameters: Type.Unsafe(tool.inputSchema),
      async execute(_id, params, signal) {
        const result = await call(tool.wireName, params, signal);
        return {
          content: [{ type: "text", text: result.text }],
          isError: !result.success
        };
      }
    });
  }
  pi.registerTool({
    name: "koed_structured_result",
    label: "Koed Structured Result",
    description:
      "Submit the final schema-constrained Koed result. Correct any validation error and resubmit until accepted.",
    parameters: Type.Unsafe(schema),
    async execute(_id, params, signal) {
      await call("koed_structured_result", params, signal);
      return {
        content: [{ type: "text", text: "Structured result accepted." }],
        details: { value: params },
        terminate: true
      };
    }
  });
}
