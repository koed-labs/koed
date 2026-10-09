/**
 * Readable recalled text, plus any requested citations or evidence. Execution
 * metadata stays in the result record.
 */
export declare function formatMemoryAnswerCompletion(
  result: unknown,
  status?: string,
  options?: {
    /** Defaults to true; false omits citation and evidence fields. */
    includeDetails?: boolean;
    /** Model-visible attribution for a deferred completion. */
    request?: { taskId: string; query: string };
  }
): string;
