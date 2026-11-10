import type { Redis } from 'ioredis';
import { EventLaneError } from './errors';

export type RawEntry = [id: string, fields: string[]];

export interface ScanOptions<T> {
  command: Redis;
  key: string;
  /** Inclusive lower bound (an id, `-`). */
  from: string;
  /** Inclusive upper bound (an id, `+`). */
  to: string;
  reverse: boolean;
  /** Continue after this id, in the direction of the scan. */
  after: string | undefined;
  /** Max items to return. */
  limit: number;
  /** Max entries to look at. */
  maxScan: number;
  /** Turns an entry into an item, or undefined to skip it. */
  map: (entry: RawEntry) => T | undefined;
}

export interface ScanResult<T> {
  items: T[];
  /** The id to continue after, or undefined when the range is exhausted. */
  next: string | undefined;
}

const CHUNK = 200;

/**
 * Walks a stream in pages, keeping the entries `map` accepts. Bounded by `limit` (items returned)
 * and `maxScan` (entries looked at), so filtering never reads a whole topic.
 */
export async function scanStream<T>(options: ScanOptions<T>): Promise<ScanResult<T>> {
  const { command, key, reverse, limit, maxScan, map } = options;
  let start = options.from;
  let end = options.to;
  if (options.after !== undefined) {
    if (reverse) end = `(${options.after}`;
    else start = `(${options.after}`;
  }

  const items: T[] = [];
  let scanned = 0;
  for (;;) {
    const entries = (
      reverse
        ? await command.call('XREVRANGE', key, end, start, 'COUNT', CHUNK)
        : await command.call('XRANGE', key, start, end, 'COUNT', CHUNK)
    ) as RawEntry[];
    for (const entry of entries) {
      scanned++;
      const item = map(entry);
      if (item !== undefined) items.push(item);
      if (items.length >= limit || scanned >= maxScan) return { items, next: entry[0] };
    }
    if (entries.length < CHUNK) return { items, next: undefined };
    const last = (entries[entries.length - 1] as RawEntry)[0];
    if (reverse) end = `(${last}`;
    else start = `(${last}`;
  }
}

/** Largest page any list returns. */
const MAX_COUNT = 1000;
/** Default number of entries looked at while filtering. */
const DEFAULT_MAX_SCAN = 10_000;

/** A page size: default 100, an integer between 1 and 1000. */
export function pageSize(count: number | undefined, name = 'count'): number {
  const resolved = count ?? 100;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > MAX_COUNT) {
    throw new EventLaneError(
      `${name} must be an integer between 1 and ${MAX_COUNT}, got ${resolved}`,
    );
  }
  return resolved;
}

export function scanLimit(maxScan: number | undefined): number {
  const resolved = maxScan ?? DEFAULT_MAX_SCAN;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new EventLaneError(`maxScan must be an integer >= 1, got ${resolved}`);
  }
  return resolved;
}
