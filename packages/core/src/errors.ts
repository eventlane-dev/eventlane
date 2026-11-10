export class EventLaneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventLaneError';
  }
}

const NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Names become part of Redis keys; `:` and whitespace are not allowed. */
export function assertName(kind: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || !NAME_PATTERN.test(value)) {
    throw new EventLaneError(
      `Invalid ${kind} ${JSON.stringify(value)}: use letters, digits, ".", "-" and "_" only`,
    );
  }
}
