import type { AgentCommand, AgentCommandResult } from "./control-client.js";

export function createInstalledAgentCommand(input: {
  executable: string;
  entrypoint: string;
  environment: NodeJS.ProcessEnv;
  run(
    executable: string,
    args: string[],
    environment: NodeJS.ProcessEnv
  ): Promise<string>;
}): (command: AgentCommand) => Promise<AgentCommandResult> {
  return async (command) => {
    const name =
      command === "start-automatic"
        ? "__control-plane-start-automatic"
        : command === "stop"
          ? "stop"
          : `__control-plane-${command}`;
    const args = [
      input.entrypoint,
      name,
      ...(command === "start-automatic" ? ["--daemon"] : []),
      "--json"
    ];
    try {
      const raw: unknown = JSON.parse(
        await input.run(input.executable, args, {
          ...input.environment,
          ELECTRON_RUN_AS_NODE: "1"
        })
      );
      if (
        !raw ||
        typeof raw !== "object" ||
        !("ok" in raw) ||
        typeof raw.ok !== "boolean"
      )
        throw new Error("Invalid control-plane response");
      const result = raw as AgentCommandResult;
      if (
        command === "agent-status" &&
        result.ok &&
        (!result.snapshot ||
          typeof result.snapshot.stopIntent !== "boolean" ||
          typeof result.snapshot.backgroundEnabled !== "boolean")
      )
        throw new Error("Invalid Agent status response");
      return result;
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  };
}
