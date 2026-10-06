/** The payment service or registry answered with an error (status 0 = no answer). */
export class MasumiApiError extends Error {
  readonly status: number;
  readonly path: string;
  constructor(status: number, path: string, detail: string) {
    super(`Masumi ${path} returned ${status}: ${detail}`);
    this.name = "MasumiApiError";
    this.status = status;
    this.path = path;
  }
}

/** A value the Masumi node would reject; raised before any network call. */
export class MasumiInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MasumiInputError";
  }
}
