import { readFileSync } from "node:fs";
import process from "node:process";
import { Type } from "typebox";

export default function structuredResult(pi) {
  const schemaPath = process.env.KOED_PI_RESULT_SCHEMA;
  if (!schemaPath) throw new Error("KOED_PI_RESULT_SCHEMA is required");
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  pi.registerTool({
    name: "koed_structured_result",
    label: "Koed Structured Result",
    description:
      "Submit final schema-constrained Koed result. Call exactly once to finish task.",
    parameters: Type.Unsafe(schema),
    async execute(_id, params) {
      return {
        content: [{ type: "text", text: "Structured result accepted." }],
        details: { value: params },
        terminate: true
      };
    }
  });
}
