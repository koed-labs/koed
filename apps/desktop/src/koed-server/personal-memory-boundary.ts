export type PersonalMemoryErrorCode =
  | "unsupported_operation"
  | "not_ready"
  | "not_found"
  | "conflict"
  | "request_failed"
  | "invalid_response";

export class PersonalMemoryBoundaryError extends Error {
  constructor(
    readonly code: PersonalMemoryErrorCode,
    readonly retryable: boolean
  ) {
    super(code);
    this.name = "PersonalMemoryBoundaryError";
  }
}
