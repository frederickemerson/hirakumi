/** An error that retrying cannot fix: the seller (or an operator) must change something first. */
export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentError";
  }
}
