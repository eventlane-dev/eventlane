import type { Redis, RedisOptions } from 'ioredis';
import type { StreamPosition } from './ids';

export type { StreamPosition };

export interface Logger {
  debug(message: string, ...context: unknown[]): void;
  info(message: string, ...context: unknown[]): void;
  warn(message: string, ...context: unknown[]): void;
  error(message: string, ...context: unknown[]): void;
}

/** ioredis connection options (host, port, username, password, db, tls, sentinels, ...). */
export type RedisConnection = RedisOptions;

export interface RetryPolicy {
  /** Total tries including the first one. Default: 5. `1` means no retry. */
  attempts?: number;
  backoff?: {
    /** `fixed` waits `delay` every time; `exponential` waits `delay * 2^(attempt-1)`. Default: exponential. */
    type?: 'fixed' | 'exponential';
    /** Milliseconds. Default: 1000. */
    delay?: number;
    /** Cap for exponential backoff in milliseconds. Default: 60000. */
    maxDelay?: number;
  };
}

export interface TopicOptions {
  /**
   * Trims the topic on every `emit`. Trimming is approximate (cheap): it removes whole internal
   * blocks, so a topic may briefly hold somewhat more than the limit. Both limits can be set.
   */
  retention?: Retention;
}

/** How much of a topic to keep; `false` keeps everything (the topic grows until Redis is full). */
export type Retention =
  | false
  | {
      /** Keep about this many of the latest events. */
      maxLen?: number;
      /** Keep about this many milliseconds of events. */
      maxAgeMs?: number;
    };

interface BaseOptions {
  /** Default consumer for subscriptions that do not set their own. */
  consumerName?: string;
  /** Unique per running instance of a consumer. Default: `hostname-pid-random`. */
  instanceName?: string;
  /** Prefix of every Redis key. Default: `events`. */
  prefix?: string;
  /** `XREADGROUP BLOCK` timeout in ms. Default: 5000. */
  blockTimeMs?: number;
  /** Max events fetched per read. Default: 50. */
  batchSize?: number;
  /** Max wait for in-flight handlers in `close()`. Default: 10000. */
  shutdownTimeoutMs?: number;
  /** Default retry policy. */
  retry?: RetryPolicy;
  /** Idle time after which a pending event is claimed from a dead instance. Default: 60000. */
  claimIdleMs?: number;
  /** How often the claim worker runs. Default: 15000. */
  claimIntervalMs?: number;
  /** How often due retries are picked up. Default: 1000. */
  retryPollMs?: number;
  /** Lifetime of dedup markers and producer idempotency keys. Default: 86400. */
  dedupTtlSeconds?: number;
  /** Approximate cap of each topic's dead-letter stream. Default: 10000. */
  dlqMaxLen?: number;
  /** Per-topic settings, keyed by topicName. */
  topics?: Record<string, TopicOptions>;
  /**
   * Retention for topics that do not set their own. Default: the latest 1 000 000 events. `false`
   * keeps everything, which grows the topic until Redis is full.
   */
  retention?: Retention;
  /** Default: silent. */
  logger?: Logger;
}

/** Provide exactly one of `redisUrl` or `redis`. */
export type EventLaneOptions = BaseOptions &
  (
    | { redisUrl: string; redis?: undefined }
    // an existing ioredis client is reused and never closed by EventLane
    | { redis: RedisConnection | Redis; redisUrl?: undefined }
  );

export interface EventMetadata {
  /** Event id (the Redis stream entry id), e.g. `1762725960000-0`. Stable across retries. */
  id: string;
  topicName: string;
  eventName: string;
  /** Consumer that received the event. */
  consumerName: string;
  /** Instance that handles the event. */
  instanceName: string;
  /** Full Redis key of the topic, e.g. `events:users`. */
  streamKey: string;
  /** Milliseconds since epoch, taken from the event id. */
  timestamp: number;
  /** 1 for the first delivery. */
  attempt: number;
  headers: Record<string, string>;
}

// biome-ignore lint/suspicious/noExplicitAny: payloads are intentionally loosely typed
export type Handler<T = any> = (payload: T, meta: EventMetadata) => Promise<void> | void;

export interface SubscribeOptions {
  /** Consumer for this subscription. Default: the bus `consumerName`. */
  consumerName?: string;
  /** Max handlers running at once for this subscription. Default: 1 (keeps order). */
  concurrency?: number;
  /** Where a consumer that does not exist yet starts: `$` (new events) or `0` (full history). */
  startFrom?: '$' | '0';
  /** Skip events this consumer already processed successfully. Default: false. */
  dedup?: boolean;
  /** Overrides the bus retry policy for this subscription. */
  retry?: RetryPolicy;
}

export interface EmitOptions {
  /** Extra metadata delivered to handlers in `meta.headers`. */
  headers?: Record<string, string>;
  /**
   * If an event with the same key was emitted within `dedupTtlSeconds`, nothing is stored and the
   * original event id is returned.
   */
  idempotencyKey?: string;
}

export interface DeadLetter {
  /** Id of the dead-letter entry (use it with `dlq.retry`). */
  id: string;
  topicName: string;
  eventName: string;
  payload: unknown;
  headers: Record<string, string>;
  /** Consumer that failed to handle the event. */
  consumerName: string;
  attempt: number;
  error: string;
  stack: string;
  /** Id of the original event. */
  originalId: string;
  /** Milliseconds since epoch. */
  failedAt: number;
}

export interface DeadLetterFilter {
  consumerName?: string;
  /** Only dead letters of events with this name. */
  eventName?: string;
  /** Max entries to return. Default: 100, at most 1000. */
  count?: number;
  /** Newest first. Default: false (oldest first). */
  reverse?: boolean;
  /** Continue after this dead-letter id (the `next` of the previous page). */
  after?: string;
  /** Max entries looked at while filtering. Default: 10000. */
  maxScan?: number;
}

/** One page of dead letters from `bus.dlq.page`. */
export interface DeadLetterPage {
  entries: DeadLetter[];
  /** Pass as `after` to get the next page; undefined when the stream is exhausted. */
  next: string | undefined;
}

export interface DeadLetterRetryOptions {
  /** Only dead letters of this consumer. */
  consumerName?: string;
  /** Only dead letters of events with this name. */
  eventName?: string;
  /** Only these dead-letter ids (as returned by `list`). */
  ids?: string[];
}

export interface PendingOptions {
  /** Max events to return. Default: 100, at most 1000. */
  count?: number;
  /** Continue after this event id. */
  after?: string;
  /** Only events held by this instance. */
  instanceName?: string;
}

/** An event delivered to an instance of a consumer and not yet acknowledged. */
export interface PendingEvent {
  id: string;
  /** Undefined when the event was trimmed from the topic while pending. */
  eventName: string | undefined;
  /** The instance that holds the event. */
  instanceName: string;
  /** Milliseconds since it was last delivered. */
  idleMs: number;
  /** How many times Redis delivered it (including to instances that died). */
  deliveries: number;
  timestamp: number;
}

export interface RetriesOptions {
  /** Max events to return. Default: 100, at most 1000. */
  count?: number;
  /** Skip this many (ordered by due time). Default: 0. */
  offset?: number;
}

/** A failed event waiting for its next retry. */
export interface RetryingEvent {
  id: string;
  eventName: string;
  /** Deliveries made so far (1 after the first failure). */
  attempt: number;
  /** Milliseconds since epoch when the retry is due. */
  dueAt: number;
  timestamp: number;
}

/**
 * Where one event stands for one consumer: `not-read` (the consumer has not reached it yet),
 * `pending` (delivered, not acknowledged), `retrying` (waiting for a retry), `dead-letter`, or
 * `done` (nothing is waiting for this consumer: it handled it, or it started after the event).
 */
export type ConsumerEventState = 'not-read' | 'pending' | 'retrying' | 'dead-letter' | 'done';

export interface ConsumerEventStatus {
  consumerName: string;
  state: ConsumerEventState;
  /** For `pending`: the instance holding the event. */
  instanceName?: string;
  /** For `pending`: milliseconds since it was delivered. */
  idleMs?: number;
  /** For `pending`: how many times it was delivered. */
  deliveries?: number;
  /** For `retrying` and `dead-letter`: deliveries made so far. */
  attempt?: number;
  /** For `retrying`: milliseconds since epoch when the retry is due. */
  dueAt?: number;
  /** For `dead-letter`: why it failed. */
  error?: string;
}

export interface EventStatus {
  /** Undefined when the event is not in the topic (never existed or was trimmed). */
  event: ReadEvent | undefined;
  consumers: ConsumerEventStatus[];
}

export type Unsubscribe = () => void;

export interface ReadOptions {
  /** Max events to return. Default: 100, at most 1000. */
  count?: number;
  /** Only events with this name. Applied while scanning, see `maxScan`. */
  eventName?: string;
  /**
   * Continue after this event id, in the direction of the read (older ones when `reverse`).
   * Pass the `next` of the previous page. Overrides `from` (or `to` when `reverse`).
   */
  after?: string;
  /** Max events looked at while filtering. Default: 10000. */
  maxScan?: number;
  /** Newest first. Default: false (oldest first). */
  reverse?: boolean;
  /** Start of the range (inclusive): an event id, a timestamp in ms or a Date. Default: the oldest. */
  from?: StreamPosition;
  /** End of the range (inclusive). Default: the newest. */
  to?: StreamPosition;
}

/** An event as stored in a topic, returned by `bus.read`. */
export interface ReadEvent {
  id: string;
  topicName: string;
  eventName: string;
  payload: unknown;
  headers: Record<string, string>;
  /** Milliseconds since epoch, taken from the event id. */
  timestamp: number;
}

/** One page of events from `bus.readPage`. */
export interface ReadPage {
  events: ReadEvent[];
  /** Pass as `after` to get the next page; undefined when the range is exhausted. */
  next: string | undefined;
}

export interface ReplayOptions {
  /** Default: the bus `consumerName`. */
  consumerName?: string;
  /**
   * Where the consumer continues reading: `'0'` (the beginning), `'$'` (skip everything stored so
   * far), an event id, or a timestamp (ms or Date). The first event delivered is the first one at
   * or after this position.
   */
  from: StreamPosition;
}

export interface InstanceStats {
  instanceName: string;
  /** Events delivered to this instance and not yet acknowledged. */
  pending: number;
  /** Milliseconds since the instance last read or acknowledged anything. */
  idleMs: number;
}

export interface StatsOptions {
  /** Also list the instances of each consumer (one extra command per consumer). */
  instances?: boolean;
}

export interface ConsumerStats {
  consumerName: string;
  /** Instances currently attached to the consumer. */
  instances: number;
  /** The instances themselves; only present with `{ instances: true }`. */
  instanceDetails?: InstanceStats[];
  /** Delivered but not yet acknowledged. */
  pending: number;
  /** Events in the topic the consumer has not read yet. Estimated (capped) before Redis 7. */
  lag: number;
  /** Failed events waiting for their next retry. */
  retrying: number;
}

export interface TopicStats {
  topicName: string;
  /** Events currently stored in the topic. */
  length: number;
  /** Events in the topic's dead-letter stream (all consumers). */
  deadLetters: number;
  consumers: ConsumerStats[];
}
