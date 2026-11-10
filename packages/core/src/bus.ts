import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { Redis } from 'ioredis';
import { ConsumerLoop, type Subscription } from './consumer-loop';
import { DeadLetters } from './dlq';
import { assertName, EventLaneError } from './errors';
import { encodeEvent, Semaphore, silentLogger, streamKey } from './internal';
import { Operations, resolveRetention, trimArguments } from './operations';
import { DEFAULT_RETRY, type ResolvedRetry, resolveRetry } from './retry';
import { EMIT_IDEMPOTENT, runScript } from './scripts';
import type {
  EmitOptions,
  EventLaneOptions,
  EventStatus,
  Handler,
  Logger,
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
  SubscribeOptions,
  TopicOptions,
  TopicStats,
  Unsubscribe,
} from './types';

const isRedisClient = (value: unknown): value is Redis =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Redis).duplicate === 'function' &&
  typeof (value as Redis).call === 'function';

function defaultInstanceName(): string {
  const host = hostname().replace(/[^A-Za-z0-9._-]/g, '-');
  return `${host}-${process.pid}-${randomBytes(3).toString('hex')}`;
}

function positiveInt(name: string, value: number | undefined, fallback: number, min = 1): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < min) {
    throw new EventLaneError(`${name} must be an integer >= ${min}, got ${resolved}`);
  }
  return resolved;
}

export class EventLaneBus {
  private readonly command: Redis;
  private readonly ownsCommand: boolean;
  private readonly prefix: string;
  private readonly instanceName: string;
  private readonly defaultConsumerName: string | undefined;
  private readonly blockTimeMs: number;
  private readonly batchSize: number;
  private readonly shutdownTimeoutMs: number;
  private readonly retry: ResolvedRetry;
  private readonly claimIdleMs: number;
  private readonly claimIntervalMs: number;
  private readonly retryPollMs: number;
  private readonly dedupTtlSeconds: number;
  private readonly dlqMaxLen: number;
  private readonly topicOptions: Map<string, TopicOptions>;
  private readonly defaultRetention: Retention | undefined;
  private readonly operations: Operations;
  private readonly logger: Logger;
  private readonly loops = new Map<string, ConsumerLoop>();
  private started = false;
  private closed = false;

  /** Inspect and re-deliver events that exhausted their retries. */
  readonly dlq: DeadLetters;

  constructor(options: EventLaneOptions) {
    const hasUrl = options.redisUrl !== undefined;
    const hasRedis = options.redis !== undefined;
    if (hasUrl === hasRedis) {
      throw new EventLaneError('Provide exactly one of "redisUrl" or "redis"');
    }

    this.prefix = options.prefix ?? 'events';
    assertName('prefix', this.prefix);
    this.instanceName = options.instanceName ?? defaultInstanceName();
    assertName('instanceName', this.instanceName);
    if (options.consumerName !== undefined) assertName('consumerName', options.consumerName);
    this.defaultConsumerName = options.consumerName;
    this.blockTimeMs = positiveInt('blockTimeMs', options.blockTimeMs, 5000);
    this.batchSize = positiveInt('batchSize', options.batchSize, 50);
    this.shutdownTimeoutMs = positiveInt('shutdownTimeoutMs', options.shutdownTimeoutMs, 10_000, 0);
    this.retry = resolveRetry(DEFAULT_RETRY, options.retry);
    this.claimIdleMs = positiveInt('claimIdleMs', options.claimIdleMs, 60_000);
    this.claimIntervalMs = positiveInt('claimIntervalMs', options.claimIntervalMs, 15_000);
    this.retryPollMs = positiveInt('retryPollMs', options.retryPollMs, 1000);
    this.dedupTtlSeconds = positiveInt('dedupTtlSeconds', options.dedupTtlSeconds, 86_400);
    this.dlqMaxLen = positiveInt('dlqMaxLen', options.dlqMaxLen, 10_000);
    this.defaultRetention = options.retention;
    this.assertRetention('retention', options.retention);
    this.topicOptions = new Map();
    for (const [topicName, topic] of Object.entries(options.topics ?? {})) {
      assertName('topicName', topicName);
      this.assertRetention(`topics.${topicName}.retention`, topic?.retention);
      this.topicOptions.set(topicName, topic ?? {});
    }
    this.logger = options.logger ?? silentLogger;

    if (typeof options.redisUrl === 'string') {
      if (options.redisUrl === '') throw new EventLaneError('"redisUrl" must not be empty');
      this.command = new Redis(options.redisUrl);
      this.ownsCommand = true;
    } else if (isRedisClient(options.redis)) {
      this.command = options.redis;
      this.ownsCommand = false;
    } else {
      this.command = new Redis(options.redis as object);
      this.ownsCommand = true;
    }
    if (this.ownsCommand) {
      this.command.on('error', (error: Error) =>
        this.logger.error(`redis connection error: ${error.message}`),
      );
    }
    this.dlq = new DeadLetters(this.command, this.prefix);
    this.operations = new Operations(this.command, this.prefix);
  }

  /** Stores an event in the topic and returns its id (the Redis stream entry id). */
  async emit(
    topicName: string,
    eventName: string,
    payload?: unknown,
    options: EmitOptions = {},
  ): Promise<string> {
    this.assertOpen();
    assertName('topicName', topicName);
    if (typeof eventName !== 'string' || eventName === '') {
      throw new EventLaneError('eventName must be a non-empty string');
    }
    const key = streamKey(this.prefix, topicName);
    const fields = encodeEvent(eventName, payload, options.headers);
    const trim = trimArguments(
      resolveRetention(this.topicOptions.get(topicName), this.defaultRetention),
      Date.now(),
    );
    if (options.idempotencyKey !== undefined) {
      if (typeof options.idempotencyKey !== 'string' || options.idempotencyKey === '') {
        throw new EventLaneError('idempotencyKey must be a non-empty string');
      }
      const id = await runScript(
        this.command,
        EMIT_IDEMPOTENT,
        [`${this.prefix}:idem:${topicName}:${options.idempotencyKey}`, key],
        [this.dedupTtlSeconds, trim.inline.length, ...trim.inline, ...fields],
      );
      await this.trimAfter(key, trim.after);
      return id as string;
    }
    const id = await this.command.call('XADD', key, ...trim.inline, '*', ...fields);
    await this.trimAfter(key, trim.after);
    return id as string;
  }

  private assertRetention(name: string, retention: Retention | undefined): void {
    if (retention === undefined || retention === false) return;
    if (retention.maxLen !== undefined) positiveInt(`${name}.maxLen`, retention.maxLen, 1);
    if (retention.maxAgeMs !== undefined) positiveInt(`${name}.maxAgeMs`, retention.maxAgeMs, 1);
  }

  private async trimAfter(key: string, after: Array<string | number> | undefined): Promise<void> {
    if (after) await this.command.call('XTRIM', key, ...after);
  }

  /** Names of the topics that exist under the prefix, sorted. */
  topics(): Promise<string[]> {
    return this.operations.topics();
  }

  /**
   * One page of stored events with the cursor for the next one: filter by `eventName`, continue
   * with `after`. Use it to browse a topic; `read` returns just the events.
   */
  readPage(topicName: string, options?: ReadOptions): Promise<ReadPage> {
    return this.operations.readPage(topicName, options);
  }

  /** Events delivered to a consumer and not yet acknowledged, oldest first. */
  pending(
    topicName: string,
    consumerName: string,
    options?: PendingOptions,
  ): Promise<PendingEvent[]> {
    return this.operations.pending(topicName, consumerName, options);
  }

  /** Failed events of a consumer waiting for their next retry, soonest first. */
  retries(
    topicName: string,
    consumerName: string,
    options?: RetriesOptions,
  ): Promise<RetryingEvent[]> {
    return this.operations.retries(topicName, consumerName, options);
  }

  /** Where one event stands for every consumer: not read, pending, retrying, dead letter or done. */
  eventStatus(topicName: string, eventId: string): Promise<EventStatus> {
    return this.operations.eventStatus(topicName, eventId);
  }

  /**
   * Stored events of a topic without affecting any consumer. Oldest first, or newest first with
   * `reverse`. `from` and `to` take an event id, a timestamp in ms or a Date.
   */
  read(topicName: string, options?: ReadOptions): Promise<ReadEvent[]> {
    return this.operations.read(topicName, options);
  }

  /**
   * Moves a consumer's read position to reprocess history (or skip it with `'$'`). The first event
   * delivered afterwards is the first one at or after `from`. Running instances follow at once.
   */
  async replay(topicName: string, options: ReplayOptions): Promise<void> {
    const consumerName = options.consumerName ?? this.defaultConsumerName;
    if (consumerName === undefined) {
      throw new EventLaneError('consumerName is required: set it on the bus or in the options');
    }
    return this.operations.replay(topicName, consumerName, options);
  }

  /** Size, dead letters and per-consumer instances, pending, lag and retries of a topic. */
  stats(topicName: string, options?: StatsOptions): Promise<TopicStats> {
    return this.operations.stats(topicName, options);
  }

  /** Deletes a consumer (position, pending list, retries). Events stay in the topic. */
  removeConsumer(topicName: string, consumerName: string): Promise<boolean> {
    return this.operations.removeConsumer(topicName, consumerName);
  }

  /** Deletes a topic with its dead letters, retries and idempotency keys. Requires `confirm`. */
  deleteTopic(topicName: string, options: { confirm: boolean }): Promise<void> {
    return this.operations.deleteTopic(topicName, options);
  }

  /** A `TopicEmitter` bound to one topic. */
  emitter(topicName: string): TopicEmitter {
    assertName('topicName', topicName);
    return new TopicEmitter(this, topicName);
  }

  on(topics: string | string[], handler: Handler, options?: SubscribeOptions): Unsubscribe;
  on(
    topics: string | string[],
    eventName: string,
    handler: Handler,
    options?: SubscribeOptions,
  ): Unsubscribe;
  on(
    topics: string | string[],
    second: string | Handler,
    third?: Handler | SubscribeOptions,
    fourth?: SubscribeOptions,
  ): Unsubscribe {
    const [eventName, handler, options] =
      typeof second === 'function'
        ? [undefined, second, third as SubscribeOptions | undefined]
        : [second, third as Handler, fourth];
    return this.subscribe(topics, eventName, handler, options ?? {});
  }

  /** Connects the consumers and starts reading. Subscriptions added later start immediately. */
  async start(): Promise<void> {
    this.assertOpen();
    this.started = true;
    await Promise.all([...this.loops.values()].map((loop) => loop.start()));
  }

  /**
   * Graceful shutdown: stops reading, waits for in-flight handlers (up to `shutdownTimeoutMs`) and
   * closes the connections EventLane opened. Unfinished events stay pending for recovery.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.started = false;
    const loops = [...this.loops.values()];
    this.loops.clear();
    for (const loop of loops) loop.stop();

    let timer: NodeJS.Timeout | undefined;
    const drained = Promise.all(loops.map((loop) => loop.drain())).then(() => true);
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), this.shutdownTimeoutMs);
    });
    const finished = await Promise.race([drained, timedOut]);
    clearTimeout(timer);

    if (finished) {
      await Promise.all(loops.map((loop) => loop.leave()));
    } else {
      this.logger.warn('shutdown timed out waiting for handlers; their events stay pending');
      for (const loop of loops) loop.markNotDrained();
    }
    if (this.ownsCommand) await this.command.quit().catch(() => this.command.disconnect());
  }

  private subscribe(
    topics: string | string[],
    eventName: string | undefined,
    handler: Handler,
    options: SubscribeOptions,
  ): Unsubscribe {
    this.assertOpen();
    if (typeof handler !== 'function') throw new EventLaneError('handler must be a function');
    if (eventName !== undefined && eventName === '') {
      throw new EventLaneError('eventName must be a non-empty string');
    }
    const topicNames = Array.isArray(topics) ? topics : [topics];
    if (topicNames.length === 0) throw new EventLaneError('at least one topicName is required');
    for (const topicName of topicNames) assertName('topicName', topicName);

    const consumerName = options.consumerName ?? this.defaultConsumerName;
    if (consumerName === undefined) {
      throw new EventLaneError(
        'consumerName is required: set it on the bus or on the subscription',
      );
    }
    assertName('consumerName', consumerName);
    const concurrency = positiveInt('concurrency', options.concurrency, 1);
    resolveRetry(this.retry, options.retry); // validate now; resolved per delivery
    const startFrom = options.startFrom ?? '$';
    if (startFrom !== '$' && startFrom !== '0') {
      throw new EventLaneError('startFrom must be "$" or "0"');
    }

    const registered: Array<{ loop: ConsumerLoop; subscription: Subscription }> = [];
    for (const topicName of new Set(topicNames)) {
      const loopKey = `${consumerName}|${topicName}`;
      let loop = this.loops.get(loopKey);
      if (!loop) {
        loop = new ConsumerLoop(
          {
            command: this.command,
            prefix: this.prefix,
            instanceName: this.instanceName,
            blockTimeMs: this.blockTimeMs,
            batchSize: this.batchSize,
            retry: this.retry,
            claimIdleMs: this.claimIdleMs,
            claimIntervalMs: this.claimIntervalMs,
            retryPollMs: this.retryPollMs,
            dedupTtlSeconds: this.dedupTtlSeconds,
            dlqMaxLen: this.dlqMaxLen,
            logger: this.logger,
          },
          topicName,
          consumerName,
        );
        this.loops.set(loopKey, loop);
      }
      const subscription: Subscription = {
        eventName,
        handler,
        concurrency,
        startFrom,
        dedup: options.dedup === true,
        retry: options.retry,
        semaphore: new Semaphore(concurrency),
      };
      if (loop.overlaps(eventName)) {
        this.logger.warn(
          `consumer "${consumerName}" has several handlers for ${
            eventName === undefined ? 'every event' : `"${eventName}"`
          } of topic "${topicName}"; they run for the same event and a failure in one retries all of them. Use separate consumers if they should fail independently.`,
        );
      }
      loop.add(subscription);
      registered.push({ loop, subscription });
      if (this.started && !loop.isRunning) {
        loop.start().catch((error) => this.logger.error(`failed to start consumer: ${error}`));
      }
    }

    return () => {
      for (const { loop, subscription } of registered) {
        loop.remove(subscription);
        if (loop.isEmpty) {
          for (const [key, value] of this.loops) if (value === loop) this.loops.delete(key);
          loop.stop();
          loop.drain().then(() => loop.leave());
        }
      }
    };
  }

  private assertOpen(): void {
    if (this.closed) throw new EventLaneError('The bus is closed');
  }
}

/** Emitter bound to one topic: `emit(eventName, payload)` without repeating the topicName. */
export class TopicEmitter {
  constructor(
    private readonly bus: EventLaneBus,
    readonly topicName: string,
  ) {}

  emit(eventName: string, payload?: unknown, options?: EmitOptions): Promise<string> {
    return this.bus.emit(this.topicName, eventName, payload, options);
  }

  on(handler: Handler, options?: SubscribeOptions): Unsubscribe;
  on(eventName: string, handler: Handler, options?: SubscribeOptions): Unsubscribe;
  on(
    second: string | Handler,
    third?: Handler | SubscribeOptions,
    fourth?: SubscribeOptions,
  ): Unsubscribe {
    return typeof second === 'function'
      ? this.bus.on(this.topicName, second, third as SubscribeOptions | undefined)
      : this.bus.on(this.topicName, second, third as Handler, fourth);
  }
}
