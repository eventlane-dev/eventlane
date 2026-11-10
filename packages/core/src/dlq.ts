import type { Redis } from 'ioredis';
import { assertName, EventLaneError } from './errors';
import { rangeBound } from './ids';
import { streamKey } from './internal';
import { pageSize, type RawEntry, scanLimit, scanStream } from './scan';
import type { DeadLetter, DeadLetterFilter, DeadLetterPage, DeadLetterRetryOptions } from './types';

export function toDeadLetter(topicName: string, [id, fields]: RawEntry): DeadLetter {
  const map = new Map<string, string>();
  for (let i = 0; i + 1 < fields.length; i += 2)
    map.set(fields[i] as string, fields[i + 1] as string);
  const parse = <T>(text: string | undefined, fallback: T): T => {
    try {
      return text === undefined ? fallback : (JSON.parse(text) as T);
    } catch {
      return text as T;
    }
  };
  return {
    id,
    topicName,
    eventName: map.get('event') ?? '',
    payload: parse<unknown>(map.get('payload'), null),
    headers: parse<Record<string, string>>(map.get('headers'), {}),
    consumerName: map.get('consumer') ?? '',
    attempt: Number(map.get('attempt') ?? 0),
    error: map.get('error') ?? '',
    stack: map.get('stack') ?? '',
    originalId: map.get('originalId') ?? '',
    failedAt: Number(map.get('failedAt') ?? 0),
  };
}

/** Largest number of entries a single multi-step operation changes per transaction. */
const BATCH = 200;

/** Inspect and re-deliver events that exhausted their retries. Reachable as `bus.dlq`. */
export class DeadLetters {
  constructor(
    private readonly command: Redis,
    private readonly prefix: string,
  ) {}

  private key(topicName: string): string {
    assertName('topicName', topicName);
    return `${streamKey(this.prefix, topicName)}:dlq`;
  }

  private async scan(
    topicName: string,
    filter: DeadLetterFilter,
    limit: number,
    maxScan: number,
  ): Promise<{ entries: DeadLetter[]; next: string | undefined }> {
    if (filter.consumerName !== undefined) assertName('consumerName', filter.consumerName);
    const { items, next } = await scanStream<DeadLetter>({
      command: this.command,
      key: this.key(topicName),
      from: '-',
      to: '+',
      reverse: filter.reverse === true,
      after: filter.after === undefined ? undefined : rangeBound(filter.after),
      limit,
      maxScan,
      map: (entry) => {
        const letter = toDeadLetter(topicName, entry);
        if (filter.consumerName !== undefined && letter.consumerName !== filter.consumerName) {
          return undefined;
        }
        if (filter.eventName !== undefined && letter.eventName !== filter.eventName) {
          return undefined;
        }
        return letter;
      },
    });
    return { entries: items, next };
  }

  /** One dead letter by its id (as returned by `list`), or undefined if it is not there. */
  async get(topicName: string, entryId: string): Promise<DeadLetter | undefined> {
    const entries = (await this.command.call(
      'XRANGE',
      this.key(topicName),
      rangeBound(entryId),
      rangeBound(entryId),
    )) as RawEntry[];
    return entries[0] ? toDeadLetter(topicName, entries[0]) : undefined;
  }

  /** Dead-lettered events of a topic, oldest first (newest first with `reverse`). */
  async list(topicName: string, filter: DeadLetterFilter = {}): Promise<DeadLetter[]> {
    return (await this.page(topicName, filter)).entries;
  }

  /** Like `list`, with the cursor for the next page. */
  async page(topicName: string, filter: DeadLetterFilter = {}): Promise<DeadLetterPage> {
    const noFilter = filter.consumerName === undefined && filter.eventName === undefined;
    const count = pageSize(filter.count);
    return this.scan(topicName, filter, count, noFilter ? count : scanLimit(filter.maxScan));
  }

  /**
   * Number of dead letters, optionally of one consumer and/or event name. Without a filter it is
   * a single `XLEN`; with one it walks the (capped) stream.
   */
  async count(
    topicName: string,
    filter: Pick<DeadLetterFilter, 'consumerName' | 'eventName'> = {},
  ): Promise<number> {
    const key = this.key(topicName);
    const length = Number(await this.command.call('XLEN', key));
    if (filter.consumerName === undefined && filter.eventName === undefined) return length;
    if (length === 0) return 0;
    return (await this.scan(topicName, filter, Number.MAX_SAFE_INTEGER, length)).entries.length;
  }

  private retryCommand(topicName: string, entryId: string, letter: DeadLetter, raw: RawEntry) {
    const fields = new Map<string, string>();
    for (let i = 0; i + 1 < raw[1].length; i += 2) {
      fields.set(raw[1][i] as string, raw[1][i + 1] as string);
    }
    const member = JSON.stringify({
      id: letter.originalId,
      event: letter.eventName,
      payload: fields.get('payload') ?? 'null',
      headers: fields.get('headers') ?? '{}',
      attempt: 0,
    });
    return {
      entryId,
      retryKey: `${streamKey(this.prefix, topicName)}:${letter.consumerName}:retry`,
      member,
    };
  }

  /**
   * Re-delivers a dead-lettered event to the consumer that failed it (not to the others) with a
   * fresh retry budget, and removes it from the dead-letter stream. A running instance of that
   * consumer picks it up on its next retry poll.
   */
  async retry(topicName: string, entryId: string): Promise<void> {
    const key = this.key(topicName);
    const entries = (await this.command.call('XRANGE', key, entryId, entryId)) as RawEntry[];
    const entry = entries[0];
    if (!entry) throw new EventLaneError(`No dead-letter entry ${entryId} in topic "${topicName}"`);
    const letter = toDeadLetter(topicName, entry);
    const { retryKey, member } = this.retryCommand(topicName, entryId, letter, entry);
    await this.command
      .multi()
      .call('ZADD', retryKey, Date.now(), member)
      .call('XDEL', key, entryId)
      .exec();
  }

  /**
   * Re-delivers many dead letters at once, each to the consumer that failed it: the listed `ids`,
   * or every dead letter matching `consumerName` and/or `eventName` (all of them without options).
   * Returns how many were re-delivered; unknown ids are skipped.
   */
  async retryMany(topicName: string, options: DeadLetterRetryOptions = {}): Promise<number> {
    const key = this.key(topicName);
    if (options.consumerName !== undefined) assertName('consumerName', options.consumerName);

    let entries: RawEntry[];
    if (options.ids !== undefined) {
      const pipeline = this.command.pipeline();
      for (const id of options.ids) pipeline.call('XRANGE', key, id, id);
      const results = (await pipeline.exec()) ?? [];
      entries = results.flatMap((r) => (r[1] as RawEntry[] | undefined)?.slice(0, 1) ?? []);
    } else {
      const length = Number(await this.command.call('XLEN', key));
      if (length === 0) return 0;
      entries = [];
      let after: string | undefined;
      do {
        const found = await this.scanRaw(topicName, options, after, length);
        entries.push(...found.entries);
        after = found.next;
      } while (after !== undefined);
    }

    let retried = 0;
    for (let i = 0; i < entries.length; i += BATCH) {
      const multi = this.command.multi();
      let queued = 0;
      for (const entry of entries.slice(i, i + BATCH)) {
        const letter = toDeadLetter(topicName, entry);
        if (letter.consumerName === '') continue;
        if (options.ids !== undefined) {
          if (options.consumerName !== undefined && letter.consumerName !== options.consumerName) {
            continue;
          }
          if (options.eventName !== undefined && letter.eventName !== options.eventName) continue;
        }
        const { retryKey, member } = this.retryCommand(topicName, entry[0], letter, entry);
        multi.call('ZADD', retryKey, Date.now(), member).call('XDEL', key, entry[0]);
        queued++;
      }
      if (queued > 0) await multi.exec();
      retried += queued;
    }
    return retried;
  }

  /** Raw matching entries, one page at a time, for operations that change them. */
  private async scanRaw(
    topicName: string,
    filter: Pick<DeadLetterFilter, 'consumerName' | 'eventName'>,
    after: string | undefined,
    maxScan: number,
  ): Promise<{ entries: RawEntry[]; next: string | undefined }> {
    const { items, next } = await scanStream<RawEntry>({
      command: this.command,
      key: this.key(topicName),
      from: '-',
      to: '+',
      reverse: false,
      after,
      limit: 1000,
      maxScan,
      map: (entry) => {
        const letter = toDeadLetter(topicName, entry);
        if (filter.consumerName !== undefined && letter.consumerName !== filter.consumerName) {
          return undefined;
        }
        if (filter.eventName !== undefined && letter.eventName !== filter.eventName) {
          return undefined;
        }
        return entry;
      },
    });
    return { entries: items, next };
  }

  /**
   * Deletes dead-lettered events: the listed `ids`, or those of one consumer and/or event name, or
   * all of them without options. Returns how many were removed.
   */
  async purge(
    topicName: string,
    filter: Pick<DeadLetterFilter, 'consumerName' | 'eventName'> & { ids?: string[] } = {},
  ): Promise<number> {
    const key = this.key(topicName);
    if (filter.ids !== undefined) {
      for (const id of filter.ids) {
        if (!/^\d+-\d+$/.test(id))
          throw new EventLaneError(`Invalid dead-letter id ${JSON.stringify(id)}`);
      }
      let removed = 0;
      for (let i = 0; i < filter.ids.length; i += BATCH) {
        removed += Number(await this.command.call('XDEL', key, ...filter.ids.slice(i, i + BATCH)));
      }
      return removed;
    }
    if (filter.consumerName === undefined && filter.eventName === undefined) {
      const length = Number(await this.command.call('XLEN', key));
      await this.command.call('DEL', key);
      return length;
    }
    const length = Number(await this.command.call('XLEN', key));
    if (length === 0) return 0;
    const letters = (await this.scan(topicName, filter, Number.MAX_SAFE_INTEGER, length)).entries;
    for (let i = 0; i < letters.length; i += BATCH) {
      await this.command.call('XDEL', key, ...letters.slice(i, i + BATCH).map((l) => l.id));
    }
    return letters.length;
  }
}
