import type { CommandDiscoveryAdapter } from "./command-discovery-adapter.js";
import { createCommandDiscoveryAdapter } from "./command-discovery-adapter.js";

export const createPiCommandDiscoveryAdapter = (
  environment: NodeJS.ProcessEnv = process.env
): CommandDiscoveryAdapter => {
  const fileAdapter = createCommandDiscoveryAdapter("pi", environment);
  return {
    async discoverCommands(args) {
      const commands = await fileAdapter.discoverCommands(args);
      return commands
        .map((command) => ({
          ...command,
          // Catalog names exclude command syntax; UI adds slash when rendering.
          name: command.name.replace(/^\/+/, ""),
          verification: "unverified" as const
        }))
        .filter(
          (command) => command.name.length > 0 && !command.name.includes("/")
        );
    }
  };
};
