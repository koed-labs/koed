import {
  managedClaudeInstructionHomeVersion,
  markManagedClaudeInstructionHome
} from "@koed/mcp-server";
import {
  loadOrCreateClaudeProjectInstructions,
  type ClaudeProjectInstructionsResult
} from "./claude-project-instructions.js";

/** A transcript-only transfer cannot restore this private instruction context. */
export const assertManagedClaudeInstructionTransferSupported = (input: {
  managedHome: string | null;
  env?: NodeJS.ProcessEnv;
}): void => {
  if (
    input.managedHome &&
    managedClaudeInstructionHomeVersion(input.managedHome, input.env) === 1
  ) {
    const code = "ManagedConversationProjectInstructionsTransferError";
    throw Object.assign(new Error(code), { name: code });
  }
};

/** Fresh sessions opt out only when explicitly disabled; marked sessions resume their frozen snapshot. */
export const managedClaudeInstructionContext = async (input: {
  managedHome: string;
  sessionId: string;
  projectPath: string | null;
  newSession?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<ClaudeProjectInstructionsResult | undefined> => {
  const env = input.env ?? process.env;
  const initialize =
    input.newSession === true && env.KOED_CLAUDE_PROJECT_INSTRUCTIONS !== "0";
  try {
    if (initialize) markManagedClaudeInstructionHome(input.managedHome, env);
    // An expected snapshot stays required even if the rollout flag is disabled.
    if (managedClaudeInstructionHomeVersion(input.managedHome, env) !== 1)
      return undefined;
    return await loadOrCreateClaudeProjectInstructions({
      managedHome: input.managedHome,
      sessionId: input.sessionId,
      projectPath: input.projectPath,
      mode: initialize ? "create" : "resume"
    });
  } catch (error) {
    const source = error instanceof Error ? error.message : "";
    const code =
      initialize &&
      /^ClaudeProjectInstructions(?:File|InvalidUtf8|TooLarge|ProjectPath|ProjectRoot|PathBoundary)/u.test(
        source
      )
        ? "ManagedConversationProjectInstructionsReadError"
        : "ManagedConversationProjectInstructionsSnapshotError";
    throw Object.assign(new Error(code), { name: code });
  }
};
