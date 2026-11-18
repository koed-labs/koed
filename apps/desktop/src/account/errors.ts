/** Safe operation categories; provider and OS error details stay in main. */
export class AccountOperationError extends Error {
  constructor(
    readonly code:
      | "storage_unavailable"
      | "browser_unavailable"
      | "configuration_invalid",
    cause?: unknown
  ) {
    super(code, { cause });
    this.name = "AccountOperationError";
  }
}
