import type { ValidationIssue } from './types';

export class EventLaneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventLaneError';
  }
}

/** Formats issues as `path: message; path: message` for logs and dead letters. */
export function formatIssues(issues: readonly ValidationIssue[]): string {
  return issues
    .map((issue) => {
      const path = (issue.path ?? [])
        .map((segment) => String(typeof segment === 'object' ? segment.key : segment))
        .join('.');
      return path === '' ? issue.message : `${path}: ${issue.message}`;
    })
    .join('; ');
}

/** A payload did not match the schema of its event. `issues` come from the schema library. */
export class ValidationError extends EventLaneError {
  constructor(
    readonly topicName: string,
    readonly eventName: string,
    readonly issues: readonly ValidationIssue[],
  ) {
    super(`Invalid payload for "${eventName}" in topic "${topicName}": ${formatIssues(issues)}`);
    this.name = 'ValidationError';
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
