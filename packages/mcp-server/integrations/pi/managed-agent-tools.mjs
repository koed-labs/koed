import process from "node:process";

// Loaded only by Koed's managed RPC host. The native UI RPC transports a
// machine-only request that the managed parent intercepts before human UI.
export default function managedAgentTools(pi, environment = process.env) {
  const register = (name, description, parameters, kind, encode) => {
    pi.registerTool({
      name,
      label:
        name === "koed_agent_intent"
          ? "Record Job intent"
          : "Record Job outcome",
      description,
      parameters,
      async execute(_id, input, signal, _update, context) {
        if (signal?.aborted || !context.hasUI)
          throw new Error("Managed Agent authority is unavailable.");
        const response = await context.ui.input(
          JSON.stringify({ kind, ...encode(input) }),
          "",
          { signal }
        );
        if (signal?.aborted || typeof response !== "string")
          throw new Error("Managed Agent authority declined the request.");
        let result;
        try {
          result = JSON.parse(response);
        } catch {
          throw new Error("Invalid managed Agent authority response.");
        }
        if (!result || typeof result !== "object" || result.recorded !== true)
          throw new Error("Managed Agent authority declined the request.");
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: result
        };
      }
    });
  };
  if (environment.KOED_MANAGED_AGENT_INTENT_TOOL === "1")
    register(
      "koed_agent_intent",
      "Record explicit user assignment before work actions. Do not call for planning, discussion, result questions, summary drafting or ambiguity. This records intent and grants no permissions.",
      {
        type: "object",
        additionalProperties: false,
        required: ["kind"],
        properties: {
          kind: { type: "string", enum: ["assign", "continue", "new_job"] },
          goal: { type: "string", minLength: 1, maxLength: 1000 }
        }
      },
      "koed_agent_intent",
      (signal) => ({ signal })
    );
  if (environment.KOED_MANAGED_AGENT_TURN_STATUS_TOOL === "1")
    register(
      "koed_agent_turn_status",
      "Report complete only when the assigned Job goal is fully done; report awaiting_owner when work needs the user's answer. Provider turn completion alone does not complete the Job.",
      {
        type: "object",
        additionalProperties: false,
        required: ["status"],
        properties: {
          status: { type: "string", enum: ["complete", "awaiting_owner"] }
        }
      },
      "koed_agent_turn_status",
      (input) => ({ status: input.status })
    );
}
