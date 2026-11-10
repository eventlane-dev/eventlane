import type { Logger } from './types';

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export const streamKey = (prefix: string, topicName: string): string => `${prefix}:${topicName}`;

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Counting semaphore with FIFO hand-off, so a woken waiter never loses its slot. */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    if (this.active < this.limit) {
      this.active++;
    } else {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    }
  }
}

export interface DecodedEvent {
  id: string;
  /** Empty when the entry has no `event` field. */
  eventName: string;
  payloadJson: string;
  headersJson: string;
  attempt: number;
  timestamp: number;
}

export function encodeEvent(
  eventName: string,
  payload: unknown,
  headers: Record<string, string> | undefined,
): string[] {
  return [
    'event',
    eventName,
    'payload',
    JSON.stringify(payload ?? null),
    'attempt',
    '1',
    'headers',
    JSON.stringify(headers ?? {}),
  ];
}

/** Reads the raw fields of a stream entry; parsing the JSON is left to the caller. */
export function decodeEvent(id: string, fields: string[]): DecodedEvent {
  const map = new Map<string, string>();
  for (let i = 0; i + 1 < fields.length; i += 2) {
    map.set(fields[i] as string, fields[i + 1] as string);
  }
  return {
    id,
    eventName: map.get('event') ?? '',
    payloadJson: map.get('payload') ?? 'null',
    headersJson: map.get('headers') ?? '{}',
    attempt: Number(map.get('attempt') ?? '1') || 1,
    timestamp: Number(id.split('-')[0]),
  };
}

export type StreamEntries = Array<[id: string, fields: string[]]>;

/**
 * Normalizes an XREADGROUP reply to a list of entries. RESP2 replies are `[[key, entries]]`;
 * RESP3 (the ioredis 6 default) replies are `[key, entries]`, a Map or a plain object.
 */
export function readEntries(raw: unknown): StreamEntries {
  if (raw === null || raw === undefined) return [];
  const result: StreamEntries = [];
  const collect = (entries: unknown): void => {
    if (Array.isArray(entries)) result.push(...(entries as StreamEntries));
  };
  if (raw instanceof Map) {
    for (const entries of raw.values()) collect(entries);
  } else if (Array.isArray(raw)) {
    if (typeof raw[0] === 'string') {
      for (let i = 1; i < raw.length; i += 2) collect(raw[i]);
    } else {
      for (const pair of raw) collect((pair as unknown[])[1]);
    }
  } else if (typeof raw === 'object') {
    for (const entries of Object.values(raw)) collect(entries);
  }
  return result;
}
