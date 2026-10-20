export type ProjectSourceExtractionFailure =
  | "unsupported_type"
  | "too_large"
  | "no_text_layer"
  | "parse_error";

export class ProjectSourceExtractionError extends Error {
  constructor(readonly reason: ProjectSourceExtractionFailure) {
    super(reason);
  }
}

export const PROJECT_SOURCE_MAX_ORIGINAL_BYTES = 25 * 1024 * 1024;
export const PROJECT_SOURCE_MAX_TEXT_BYTES = 25 * 1024 * 1024;
