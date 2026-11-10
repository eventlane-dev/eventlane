import type { Redis } from 'ioredis';
import { toDeadLetter } from './dlq';
import { assertName, EventLaneError } from './errors';
import { compareStreamIds, rangeBound, replayStartId } from './ids';
import { decodeEvent, streamKey } from './internal';
import { pageSize, type RawEntry, scanLimit, scanStream } from './scan';
import type {
  ConsumerEventStatus,
  ConsumerStats,
  EventStatus,
  PendingEvent,
  PendingOptions,
  ReadEvent,
  ReadOptions,
  ReadPage,
  ReplayOptions,
  Retention,
  RetriesOptions,
  RetryingEvent,
  StatsOptions,
  TopicOptions,
  TopicStats,
} from './types';

/** Estimating lag by scanning is capped so a huge backlog stays cheap to report. */
const LAG_ESTIMATE_CAP = 10_000;
/** Retry sets are searched up to this many members when looking for one event. */
const RETRY_SEARCH_CAP = 5000;

/**
 * XINFO replies are flat arrays on RESP2 and Maps or objects on RESP3; both become a plain record.
 */
function toRecord(raw: unknown): Record<string, unknown> {
  if (raw instanceof Map) return Object.fromEntries(raw);
  if (Array.isArray(raw)) {
    const record: Record<string, unknown> = {};
    for (let i = 0; i + 1 < raw.length; i += 2) record[String(raw[i])] = raw[i + 1];
    return record;
  }
  return (raw ?? {}) as Record<string, unknown>;
}

const toNumber = (value: unknown): number => Number(value ?? 0) || 0;

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function assertEventId(id: string, name = 'id'): void {
  if (typeof id !== 'string' || !/^\d+-\d+$/.test(id)) {
    throw new EventLaneError(
      `Invalid ${name} ${JSON.stringify(id)}: expected an event id like 1762725960000-0`,
    );
  }
}

/**
 * ZRANGE ... WITHSCORES is a flat array on RESP2 and a list of `[member, score]` pairs on RESP3.
 */
function memberScores(raw: unknown): Array<{ member: string; score: number }> {
  if (!Array.isArray(raw)) return [];
  const result: Array<{ member: string; score: number }> = [];
  if (Array.isArray(raw[0])) {
    for (const pair of raw as Array<[string, number | string]>) {
      result.push({ member: String(pair[0]), score: Number(pair[1]) });
    }
  } else {
    for (let i = 0; i + 1 < raw.length; i += 2) {
      result.push({ member: String(raw[i]), score: Number(raw[i + 1]) });
    }
  }
  return result;
}

interface StoredRetry {
  id: string;
  event: string;
  attempt: number;
}

/**
 * Maintenance and inspection of topics. Reachable through the bus as `topics`, `read`,
 * `readPage`, `replay`, `stats`, `pending`, `retries`, `eventStatus`, `removeConsumer` and
 * `deleteTopic`.
 */
export class Operations {
  constructor(
    private readonly command: Redis,
    private readonly prefix: string,
  ) {}

  private key(topicName: string): string {
    assertName('topicName', topicName);
    return streamKey(this.prefix, topicName);
  }

  /** Names of the topics under the prefix, sorted. Found with SCAN, never KEYS. */
  async topics(): Promise<string[]> {
    const names = new Set<string>();
    let cursor = '0';
    do {
      const [next, keys] = (await this.command.call(
        'SCAN',
        cursor,
        'MATCH',
        `${this.prefix}:*`,
        'COUNT',
        500,
        'TYPE',
        'stream',
      )) as [string, string[]];
      cursor = String(next);
      for (const key of keys) {
        // a topic key has no further ':' (dead-letter streams do), and only streams are listed
        const name = key.slice(this.prefix.length + 1);
        if (/^[A-Za-z0-9._-]+$/.test(name)) names.add(name);
      }
    } while (cursor !== '0');
    return [...names].sort();
  }

  async read(topicName: string, options: ReadOptions = {}): Promise<ReadEvent[]> {
    return (await this.readPage(topicName, options)).events;
  }

  async readPage(topicName: string, options: ReadOptions = {}): Promise<ReadPage> {
    const key = this.key(topicName);
    const { items, next } = await scanStream<ReadEvent>({
      command: this.command,
      key,
      from: options.from === undefined ? '-' : rangeBound(options.from),
      to: options.to === undefined ? '+' : rangeBound(options.to),
      reverse: options.reverse === true,
      after: options.after === undefined ? undefined : rangeBound(options.after),
      limit: pageSize(options.count),
      maxScan:
        options.eventName === undefined ? pageSize(options.count) : scanLimit(options.maxScan),
      map: (entry) => {
        const event = this.toReadEvent(topicName, entry);
        return options.eventName === undefined || event.eventName === options.eventName
          ? event
          : undefined;
      },
    });
    return { events: items, next };
  }

  private toReadEvent(topicName: string, [id, fields]: RawEntry): ReadEvent {
    const event = decodeEvent(id, fields);
    return {
      id,
      topicName,
      eventName: event.eventName,
      payload: parseJson<unknown>(event.payloadJson, event.payloadJson),
      headers: parseJson<Record<string, string>>(event.headersJson, {}),
      timestamp: event.timestamp,
    };
  }

  async replay(topicName: string, consumerName: string, options: ReplayOptions): Promise<void> {
    const key = this.key(topicName);
    assertName('consumerName', consumerName);
    const id = replayStartId(options.from);
    try {
      await this.command.call('XGROUP', 'SETID', key, consumerName, id);
    } catch (error) {
      // NOGROUP: the topic exists without that consumer; the other: the topic does not exist yet
      if (!/NOGROUP|requires the key to exist/.test(String(error))) throw error;
      // a consumer that has not started yet: create it (and the topic) at the requested position
      await this.command.call('XGROUP', 'CREATE', key, consumerName, id, 'MKSTREAM');
    }
  }

  private async groups(key: string): Promise<Array<Record<string, unknown>>> {
    try {
      const raw = (await this.command.call('XINFO', 'GROUPS', key)) as unknown[];
      return raw.map(toRecord);
    } catch (error) {
      if (!String(error).includes('no such key')) throw error;
      return [];
    }
  }

  async stats(topicName: string, options: StatsOptions = {}): Promise<TopicStats> {
    const key = this.key(topicName);
    const length = toNumber(await this.command.call('XLEN', key));
    const deadLetters = toNumber(await this.command.call('XLEN', `${key}:dlq`));

    const consumers: ConsumerStats[] = [];
    for (const group of await this.groups(key)) {
      const consumerName = String(group.name);
      const lag =
        group.lag === null || group.lag === undefined
          ? await this.estimateLag(key, String(group['last-delivered-id'] ?? '0-0'))
          : toNumber(group.lag);
      const stats: ConsumerStats = {
        consumerName,
        instances: toNumber(group.consumers),
        pending: toNumber(group.pending),
        lag,
        retrying: toNumber(await this.command.call('ZCARD', `${key}:${consumerName}:retry`)),
      };
      if (options.instances) {
        const raw = (await this.command.call('XINFO', 'CONSUMERS', key, consumerName)) as unknown[];
        stats.instanceDetails = raw.map(toRecord).map((instance) => ({
          instanceName: String(instance.name),
          pending: toNumber(instance.pending),
          idleMs: toNumber(instance.idle),
        }));
      }
      consumers.push(stats);
    }
    return { topicName, length, deadLetters, consumers };
  }

  private async estimateLag(key: string, lastDeliveredId: string): Promise<number> {
    const entries = (await this.command.call(
      'XRANGE',
      key,
      `(${lastDeliveredId}`,
      '+',
      'COUNT',
      LAG_ESTIMATE_CAP,
    )) as unknown[];
    return entries.length;
  }

  /** Events delivered to a consumer and not yet acknowledged, oldest first. */
  async pending(
    topicName: string,
    consumerName: string,
    options: PendingOptions = {},
  ): Promise<PendingEvent[]> {
    const key = this.key(topicName);
    assertName('consumerName', consumerName);
    if (options.instanceName !== undefined) assertName('instanceName', options.instanceName);
    if (options.after !== undefined) assertEventId(options.after, 'after');

    let rows: Array<[string, string, number, number]>;
    try {
      rows = (await this.command.call(
        'XPENDING',
        key,
        consumerName,
        options.after === undefined ? '-' : `(${options.after}`,
        '+',
        pageSize(options.count),
        ...(options.instanceName === undefined ? [] : [options.instanceName]),
      )) as Array<[string, string, number, number]>;
    } catch (error) {
      if (String(error).includes('NOGROUP')) return [];
      throw error;
    }
    if (rows.length === 0) return [];

    // the event names live in the topic; a trimmed event has none
    const pipeline = this.command.pipeline();
    for (const [id] of rows) pipeline.call('XRANGE', key, id, id);
    const entries = (await pipeline.exec()) ?? [];
    return rows.map(([id, instanceName, idle, deliveries], index) => {
      const entry = (entries[index]?.[1] as RawEntry[] | undefined)?.[0];
      return {
        id,
        eventName: entry ? decodeEvent(id, entry[1]).eventName : undefined,
        instanceName: String(instanceName),
        idleMs: toNumber(idle),
        deliveries: toNumber(deliveries),
        timestamp: Number(id.split('-')[0]),
      };
    });
  }

  /** Failed events waiting for a retry, soonest first. */
  async retries(
    topicName: string,
    consumerName: string,
    options: RetriesOptions = {},
  ): Promise<RetryingEvent[]> {
    const key = this.key(topicName);
    assertName('consumerName', consumerName);
    const offset = options.offset ?? 0;
    if (!Number.isInteger(offset) || offset < 0) {
      throw new EventLaneError(`offset must be an integer >= 0, got ${offset}`);
    }
    const count = pageSize(options.count);
    const raw = await this.command.call(
      'ZRANGE',
      `${key}:${consumerName}:retry`,
      offset,
      offset + count - 1,
      'WITHSCORES',
    );
    return memberScores(raw).map(({ member, score }) => {
      const stored = JSON.parse(member) as StoredRetry;
      return {
        id: stored.id,
        eventName: stored.event,
        attempt: stored.attempt,
        dueAt: score,
        timestamp: Number(stored.id.split('-')[0]),
      };
    });
  }

  /** Where one event stands for every consumer of the topic. */
  async eventStatus(topicName: string, eventId: string): Promise<EventStatus> {
    const key = this.key(topicName);
    assertEventId(eventId, 'eventId');

    const entry = ((await this.command.call('XRANGE', key, eventId, eventId)) as RawEntry[])[0];
    const event = entry ? this.toReadEvent(topicName, entry) : undefined;

    // dead letters of this event, found once for all consumers (the stream is capped)
    const dlqLength = toNumber(await this.command.call('XLEN', `${key}:dlq`));
    const deadLetters =
      dlqLength === 0
        ? []
        : (
            await scanStream({
              command: this.command,
              key: `${key}:dlq`,
              from: '-',
              to: '+',
              reverse: false,
              after: undefined,
              limit: Number.MAX_SAFE_INTEGER,
              maxScan: dlqLength,
              map: (e) => {
                const letter = toDeadLetter(topicName, e);
                return letter.originalId === eventId ? letter : undefined;
              },
            })
          ).items;

    const consumers: ConsumerEventStatus[] = [];
    for (const group of await this.groups(key)) {
      const consumerName = String(group.name);
      const lastDelivered = String(group['last-delivered-id'] ?? '0-0');

      if (compareStreamIds(eventId, lastDelivered) > 0) {
        consumers.push({ consumerName, state: 'not-read' });
        continue;
      }
      const pending = (await this.command.call(
        'XPENDING',
        key,
        consumerName,
        eventId,
        eventId,
        1,
      )) as Array<[string, string, number, number]>;
      if (pending[0]) {
        consumers.push({
          consumerName,
          state: 'pending',
          instanceName: String(pending[0][1]),
          idleMs: toNumber(pending[0][2]),
          deliveries: toNumber(pending[0][3]),
        });
        continue;
      }
      const retry = await this.findRetry(key, consumerName, eventId);
      if (retry) {
        consumers.push({
          consumerName,
          state: 'retrying',
          attempt: retry.attempt,
          dueAt: retry.dueAt,
        });
        continue;
      }
      const letter = deadLetters.find((l) => l.consumerName === consumerName);
      if (letter) {
        consumers.push({
          consumerName,
          state: 'dead-letter',
          attempt: letter.attempt,
          error: letter.error,
        });
        continue;
      }
      consumers.push({ consumerName, state: 'done' });
    }
    return { event, consumers };
  }

  private async findRetry(
    key: string,
    consumerName: string,
    eventId: string,
  ): Promise<{ attempt: number; dueAt: number } | undefined> {
    const raw = await this.command.call(
      'ZRANGE',
      `${key}:${consumerName}:retry`,
      0,
      RETRY_SEARCH_CAP - 1,
      'WITHSCORES',
    );
    for (const { member, score } of memberScores(raw)) {
      const stored = JSON.parse(member) as StoredRetry;
      if (stored.id === eventId) return { attempt: stored.attempt, dueAt: score };
    }
    return undefined;
  }

  /**
   * Deletes a consumer (its read position, pending list and retry set). Events stay in the topic.
   * Running instances of that consumer recreate it at the end of the topic, so stop them first.
   */
  async removeConsumer(topicName: string, consumerName: string): Promise<boolean> {
    const key = this.key(topicName);
    assertName('consumerName', consumerName);
    const destroyed = toNumber(await this.command.call('XGROUP', 'DESTROY', key, consumerName));
    const retries = toNumber(await this.command.call('DEL', `${key}:${consumerName}:retry`));
    return destroyed > 0 || retries > 0;
  }

  /** Deletes a topic with everything attached to it. Destructive: requires `{ confirm: true }`. */
  async deleteTopic(topicName: string, options: { confirm: boolean }): Promise<void> {
    if (options?.confirm !== true) {
      throw new EventLaneError('deleteTopic is destructive: pass { confirm: true }');
    }
    const key = this.key(topicName);
    const stats = await this.stats(topicName);
    const keys = [
      key,
      `${key}:dlq`,
      ...stats.consumers.map((c) => `${key}:${c.consumerName}:retry`),
    ];
    await this.command.call('UNLINK', ...keys);

    // producer idempotency keys of this topic
    let cursor = '0';
    do {
      const [next, found] = (await this.command.call(
        'SCAN',
        cursor,
        'MATCH',
        `${this.prefix}:idem:${topicName}:*`,
        'COUNT',
        500,
      )) as [string, string[]];
      cursor = String(next);
      if (found.length > 0) await this.command.call('UNLINK', ...found);
    } while (cursor !== '0');
  }
}

/** Applied to topics that set no retention of their own and to buses that set no default. */
export const DEFAULT_RETENTION: Retention = { maxLen: 1_000_000 };

/** A topic's own setting wins, then the bus default, then `DEFAULT_RETENTION`. */
export function resolveRetention(
  topic: TopicOptions | undefined,
  busDefault: Retention | undefined,
): Retention {
  return topic?.retention ?? busDefault ?? DEFAULT_RETENTION;
}

/** Trim arguments for `XADD` derived from retention settings (`false` trims nothing). */
export function trimArguments(
  retention: Retention,
  now: number,
): { inline: Array<string | number>; after: Array<string | number> | undefined } {
  if (!retention) return { inline: [], after: undefined };
  const minId = (ageMs: number): string => `${Math.max(0, now - ageMs)}-0`;
  if (retention.maxLen !== undefined) {
    return {
      inline: ['MAXLEN', '~', retention.maxLen],
      // XADD takes a single trim strategy, so an age limit runs as a follow-up XTRIM
      after:
        retention.maxAgeMs !== undefined ? ['MINID', '~', minId(retention.maxAgeMs)] : undefined,
    };
  }
  if (retention.maxAgeMs !== undefined) {
    return { inline: ['MINID', '~', minId(retention.maxAgeMs)], after: undefined };
  }
  return { inline: [], after: undefined };
}
