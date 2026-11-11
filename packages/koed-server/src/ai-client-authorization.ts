import {
  aiClientConnectionRevision,
  grantAiClientConnection,
  revokeAiClientConnection,
  type AiClientConnectionId
} from "@koed-labs/shared/ai-client-connections";
import type { collectKoedServerStatus } from "./status.js";

// Only these two operations change whether Koed reads an AI Client's
// conversations. Setup connects a client only after it was verified for this
// KOED_HOME and only if nothing changed the client while it ran. Removal
// disconnects the client before touching its integration, so a failed or
// interrupted removal never leaves capture running.

const clientNames: Record<AiClientConnectionId, string> = {
  codex: "Codex",
  claude: "Claude Code",
  pi: "Pi"
};

interface OperationResult {
  ok: boolean;
  koedHome: string;
  error?: string;
}

const failed = <R extends OperationResult>(result: R, error: string): R => ({
  ...result,
  ok: false,
  error
});

/** The revision a setup notes before it changes the client's integration. */
export const noteAiClientConnectionRevision = (
  koedHome: string,
  client: AiClientConnectionId
): number => {
  try {
    return aiClientConnectionRevision(koedHome, client);
  } catch {
    // An unreadable or earlier-format record grants nothing. Replacing it
    // disconnects every client, then this setup can connect its own.
    revokeAiClientConnection(koedHome, client);
    return aiClientConnectionRevision(koedHome, client);
  }
};

export const connectAiClientAfterSetup = async <R extends OperationResult>({
  client,
  koedHome,
  run,
  verify
}: {
  client: AiClientConnectionId;
  koedHome: string;
  run: () => Promise<R>;
  verify: (koedHome: string) => Promise<boolean>;
}): Promise<R> => {
  const name = clientNames[client];
  const revision = noteAiClientConnectionRevision(koedHome, client);
  const result = await run();
  if (!result.ok) return result;
  if (result.koedHome !== koedHome)
    return failed(
      result,
      `${name} was set up for a different KOED_HOME; capture stays off.`
    );
  let verified = false;
  try {
    verified = await verify(koedHome);
  } catch {
    verified = false;
  }
  if (!verified)
    return failed(
      result,
      `Could not verify the ${name} integration for this KOED_HOME; capture stays off.`
    );
  let granted = false;
  try {
    granted = grantAiClientConnection(koedHome, client, revision);
  } catch (error) {
    return failed(
      result,
      `${name} could not be connected; capture stays off. ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return granted
    ? result
    : failed(
        result,
        `${name} changed while setup ran (for example, it was removed); capture stays off. Set it up again to connect it.`
      );
};

export const disconnectAiClientThenRemove = <R extends OperationResult>({
  client,
  koedHome,
  remove
}: {
  client: AiClientConnectionId;
  koedHome: string;
  remove: () => R;
}): R => {
  let revocationError: string | null = null;
  try {
    revokeAiClientConnection(koedHome, client);
  } catch (error) {
    revocationError = error instanceof Error ? error.message : String(error);
  }
  // The User asked to remove the integration, so it is removed even when the
  // disconnection could not be recorded; the failure is still reported.
  const result = remove();
  if (revocationError !== null)
    return failed(
      result,
      `${clientNames[client]} could not be disconnected; Koed may still read its conversations. ${revocationError}`
    );
  return result;
};

/** Verifies through a status check that is not allowed to change connections. */
export const verifyAiClientIntegration = async (
  client: AiClientConnectionId,
  koedHome: string,
  environment: NodeJS.ProcessEnv,
  collectStatus: typeof collectKoedServerStatus,
  dependencies: Parameters<typeof collectKoedServerStatus>[1] = {}
): Promise<boolean> => {
  const status = await collectStatus(
    { ...environment, KOED_HOME: koedHome },
    { ...dependencies, revokeAiClientConnection: () => false }
  );
  const inspected =
    client === "codex"
      ? status.codex
      : client === "claude"
        ? status.claudeCode
        : status.pi;
  const details = inspected?.details as
    | { configuredKoedHome?: string; mcpAdapter?: string }
    | undefined;
  return (
    status.koedHome === koedHome &&
    inspected?.configured === true &&
    (client !== "codex" ||
      (details?.configuredKoedHome === koedHome &&
        typeof details.mcpAdapter === "string"))
  );
};
