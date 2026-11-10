import { EventLaneError } from './errors';
import type { RetryPolicy } from './types';

export interface ResolvedRetry {
  /** Total tries including the first one. */
  attempts: number;
  type: 'fixed' | 'exponential';
  delay: number;
  maxDelay: number;
}

export const DEFAULT_RETRY: ResolvedRetry = {
  attempts: 5,
  type: 'exponential',
  delay: 1000,
  maxDelay: 60_000,
};

function integer(name: string, value: number, min: number): number {
  if (!Number.isInteger(value) || value < min) {
    throw new EventLaneError(`${name} must be an integer >= ${min}, got ${value}`);
  }
  return value;
}

export function resolveRetry(base: ResolvedRetry, override?: RetryPolicy): ResolvedRetry {
  if (!override) return base;
  const type = override.backoff?.type ?? base.type;
  if (type !== 'fixed' && type !== 'exponential') {
    throw new EventLaneError(`retry backoff type must be "fixed" or "exponential", got ${type}`);
  }
  return {
    attempts: integer('retry.attempts', override.attempts ?? base.attempts, 1),
    type,
    delay: integer('retry.backoff.delay', override.backoff?.delay ?? base.delay, 0),
    maxDelay: integer('retry.backoff.maxDelay', override.backoff?.maxDelay ?? base.maxDelay, 0),
  };
}

/** Milliseconds to wait before the retry that follows the failed attempt number `failedAttempt`. */
export function backoffDelay(policy: ResolvedRetry, failedAttempt: number): number {
  if (policy.type === 'fixed') return policy.delay;
  return Math.min(policy.maxDelay, policy.delay * 2 ** Math.max(0, failedAttempt - 1));
}
