import { fileURLToPath } from "node:url";

/** Launch-scoped recall connection; credentials remain in the local runtime. */
export const managedKoedMcpServer = (environment: NodeJS.ProcessEnv) => {
  const koedHome = environment.KOED_HOME?.trim();
  if (!koedHome) return undefined;
  return {
    type: "stdio" as const,
    command: process.execPath,
    args: [fileURLToPath(new URL("./cli.js", import.meta.url))],
    env: {
      KOED_HOME: koedHome,
      ...(environment.KOED_MANAGED_WORK_ITEM_COMPLETION === "1"
        ? { KOED_MANAGED_WORK_ITEM_COMPLETION: "1" }
        : {}),
      ...(environment.ELECTRON_RUN_AS_NODE === "1"
        ? { ELECTRON_RUN_AS_NODE: "1" }
        : {})
    }
  };
};
