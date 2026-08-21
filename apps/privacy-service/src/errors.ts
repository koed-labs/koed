export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly detail: string,
    readonly code: string
  ) {
    super(detail);
    this.name = "HttpError";
  }
}

export class ClassificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClassificationError";
  }
}
