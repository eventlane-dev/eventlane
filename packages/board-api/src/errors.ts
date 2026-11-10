/** An error that is the caller's fault; answered with its status instead of a 500. */
export class BoardError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'BoardError';
  }
}
