import { EventLaneError } from './errors';

const MAX_SEQ = 18446744073709551615n;

/** A point in a topic: a stream id (`ms-seq`), a millisecond timestamp (number, Date or digits). */
export type StreamPosition = string | number | Date;

/** Normalizes a position for XRANGE-style bounds; `-` and `+` pass through. */
export function rangeBound(value: StreamPosition): string {
  if (value instanceof Date) return String(value.getTime());
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) {
      throw new EventLaneError(`Invalid position ${value}: expected a non-negative integer (ms)`);
    }
    return String(value);
  }
  if (value === '-' || value === '+' || /^\d+(-\d+)?$/.test(value)) return value;
  throw new EventLaneError(`Invalid position ${JSON.stringify(value)}`);
}

/**
 * The id to pass to `XGROUP SETID` so that a consumer's next delivery is the first event at or
 * after `from` (SETID itself is exclusive, so this is the id just before it).
 */
export function replayStartId(from: StreamPosition): string {
  if (from === '$') return '$';
  let ms: bigint;
  let seq: bigint;
  if (from instanceof Date || typeof from === 'number') {
    ms = BigInt(rangeBound(from));
    seq = 0n;
  } else if (/^\d+$/.test(from)) {
    ms = BigInt(from);
    seq = 0n;
  } else if (/^\d+-\d+$/.test(from)) {
    const [m, s] = from.split('-') as [string, string];
    ms = BigInt(m);
    seq = BigInt(s);
  } else {
    throw new EventLaneError(`Invalid replay position ${JSON.stringify(from)}`);
  }
  if (seq > 0n) return `${ms}-${seq - 1n}`;
  if (ms === 0n) return '0-0';
  return `${ms - 1n}-${MAX_SEQ}`;
}

/** Orders two stream ids (`ms-seq`): negative if a is older than b, 0 if equal, positive if newer. */
export function compareStreamIds(a: string, b: string): number {
  const [aMs, aSeq] = a.split('-') as [string, string | undefined];
  const [bMs, bSeq] = b.split('-') as [string, string | undefined];
  const ms = BigInt(aMs) - BigInt(bMs);
  if (ms !== 0n) return ms < 0n ? -1 : 1;
  const seq = BigInt(aSeq ?? '0') - BigInt(bSeq ?? '0');
  return seq === 0n ? 0 : seq < 0n ? -1 : 1;
}
