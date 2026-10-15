import type pg from "pg";

/** Reject transcript-only transfers for Claude sessions with frozen Project guidance. */
export const assertManagedClaudeProjectInstructionsTransferSupported = async (
  client: pg.PoolClient,
  input: {
    ownerUserId: string;
    provider: string;
    logicalSessionId: string | null;
  }
): Promise<void> => {
  if (input.provider !== "claude" || !input.logicalSessionId) return;
  const result = await client.query<{ marked: boolean }>(
    `select exists (
       select 1
         from sessions
        where owner_user_id = $1
          and logical_session_id = $2
          and metadata -> 'claudeProjectInstructionsVersion' = '1'::jsonb
     ) as marked`,
    [input.ownerUserId, input.logicalSessionId]
  );
  if (result.rows[0]?.marked) {
    const name = "ManagedConversationProjectInstructionsTransferError";
    throw Object.assign(
      new Error(
        "Managed Conversation Project instruction context cannot be transferred"
      ),
      {
        name,
        statusCode: 409,
        code: "managed_conversation_project_instructions_transfer_unsupported"
      }
    );
  }
};
