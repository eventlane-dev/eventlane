import type { Redis } from 'ioredis';
import {
  type DecodedEvent,
  decodeEvent,
  readEntries,
  type Semaphore,
  type StreamEntries,
  silentLogger,
  sleep,
  streamKey,
} from './internal';
import { backoffDelay, type ResolvedRetry, resolveRetry } from './retry';
import { DEAD_LETTER, RETRY_CLAIM, RETRY_SCHEDULE, runScript } from './scripts';
import type { EventMetadata, Handler, Logger, RetryPolicy } from './types';

export interface Subscription {
  eventName: string | undefined;
  handler: Handler;
  concurrency: number;
  startFrom: '$' | '0';
  dedup: boolean;
  retry: RetryPolicy | undefined;
  semaphore: Semaphore;
}

export interface LoopContext {
  command: Redis;
  prefix: string;
  instanceName: string;
  blockTimeMs: number;
  batchSize: number;
  retry: ResolvedRetry;
  claimIdleMs: number;
  claimIntervalMs: number;
  retryPollMs: number;
  dedupTtlSeconds: number;
  dlqMaxLen: number;
  logger: Logger;
}

/**
 * One delivery of an event to this consumer: either an entry of the topic's stream (read, or
 * claimed from a dead instance) or a due retry taken from the consumer's retry set.
 */
interface Delivery extends DecodedEvent {
  /** Set when the delivery comes from the retry set; the exact member string we hold a lease on. */
  retryMember?: string;
}

/**
 * Reads one topic for one consumer (a Redis consumer group) on a dedicated blocking connection
 * and dispatches events to the matching subscriptions. An event is acknowledged only after every
 * matching handler succeeded. Failures are retried with backoff and end in the dead-letter stream;
 * events held by dead instances are claimed with XAUTOCLAIM.
 */
export class ConsumerLoop {
  private readonly subscriptions = new Set<Subscription>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly activeIds = new Set<string>();
  private readonly ticks = new Set<Promise<void>>();
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly key: string;
  private readonly retryKey: string;
  private readonly dlqKey: string;
  private readonly label: string;
  private readonly logger: Logger;
  private blockClient: Redis | undefined;
  private runPromise: Promise<void> | undefined;
  private stopped = true;
  private cleanlyDrained = true;
  private claiming = false;
  private retrying = false;

  constructor(
    private readonly ctx: LoopContext,
    readonly topicName: string,
    readonly consumerName: string,
  ) {
    this.key = streamKey(ctx.prefix, topicName);
    this.retryKey = `${this.key}:${consumerName}:retry`;
    this.dlqKey = `${this.key}:dlq`;
    this.label = `${this.key}/${consumerName}`;
    this.logger = ctx.logger ?? silentLogger;
  }

  get isRunning(): boolean {
    return !this.stopped;
  }

  get isEmpty(): boolean {
    return this.subscriptions.size === 0;
  }

  /** True when a handler already registered here would also receive events named `eventName`. */
  overlaps(eventName: string | undefined): boolean {
    for (const existing of this.subscriptions) {
      if (
        existing.eventName === undefined ||
        eventName === undefined ||
        existing.eventName === eventName
      ) {
        return true;
      }
    }
    return false;
  }

  add(subscription: Subscription): void {
    this.subscriptions.add(subscription);
  }

  remove(subscription: Subscription): void {
    this.subscriptions.delete(subscription);
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    await this.ensureGroup();
    this.stopped = false;
    this.cleanlyDrained = true;
    const client = this.ctx.command.duplicate();
    client.on('error', (error: Error) =>
      this.logger.error(`[${this.label}] connection error: ${error.message}`),
    );
    this.blockClient = client;
    this.runPromise = this.run(client);
    this.schedule(() => this.claimTick(), this.ctx.claimIntervalMs);
    this.schedule(() => this.retryTick(), this.ctx.retryPollMs);
    this.trackTick(() => this.claimTick());
  }

  /** Stops reading immediately; in-flight handlers keep running until `drain()` resolves. */
  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.splice(0)) clearInterval(timer);
    this.blockClient?.disconnect();
  }

  /** Resolves when the read loop has exited and every in-flight handler has settled. */
  async drain(): Promise<void> {
    await this.runPromise;
    await Promise.allSettled([...this.ticks]);
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  /** Removes this instance from the consumer when it holds no pending events. */
  async leave(): Promise<void> {
    if (!this.cleanlyDrained) return;
    const { command, instanceName } = this.ctx;
    try {
      const pending = (await command.call(
        'XPENDING',
        this.key,
        this.consumerName,
        '-',
        '+',
        1,
        instanceName,
      )) as unknown[];
      // DELCONSUMER would drop pending entries, so only remove an idle instance
      if (pending.length === 0) {
        await command.call('XGROUP', 'DELCONSUMER', this.key, this.consumerName, instanceName);
      }
    } catch (error) {
      this.logger.warn(`[${this.label}] could not leave consumer: ${error}`);
    }
  }

  markNotDrained(): void {
    this.cleanlyDrained = false;
  }

  private async ensureGroup(): Promise<void> {
    const startFrom = [...this.subscriptions][0]?.startFrom ?? '$';
    try {
      await this.ctx.command.call(
        'XGROUP',
        'CREATE',
        this.key,
        this.consumerName,
        startFrom,
        'MKSTREAM',
      );
    } catch (error) {
      if (!String(error).includes('BUSYGROUP')) throw error;
    }
  }

  private maxConcurrency(): number {
    let max = 1;
    for (const subscription of this.subscriptions) max = Math.max(max, subscription.concurrency);
    return max;
  }

  private freeSlots(): number {
    return Math.max(0, this.maxConcurrency() - this.inFlight.size);
  }

  private spawn(delivery: Delivery): void {
    const task: Promise<void> = this.handle(delivery).finally(() => {
      this.inFlight.delete(task);
    });
    this.inFlight.add(task);
  }

  private schedule(fn: () => Promise<void>, everyMs: number): void {
    const timer = setInterval(() => this.trackTick(fn), everyMs);
    timer.unref();
    this.timers.push(timer);
  }

  private trackTick(fn: () => Promise<void>): void {
    if (this.stopped) return;
    const tick: Promise<void> = fn()
      .catch((error) => this.logger.error(`[${this.label}] background task failed: ${error}`))
      .finally(() => {
        this.ticks.delete(tick);
      });
    this.ticks.add(tick);
  }

  private async run(client: Redis): Promise<void> {
    const { instanceName, batchSize, blockTimeMs } = this.ctx;
    while (!this.stopped) {
      let entries: StreamEntries;
      try {
        entries = readEntries(
          await client.call(
            'XREADGROUP',
            'GROUP',
            this.consumerName,
            instanceName,
            'COUNT',
            batchSize,
            'BLOCK',
            blockTimeMs,
            'STREAMS',
            this.key,
            '>',
          ),
        );
      } catch (error) {
        if (this.stopped) return;
        this.logger.error(`[${this.label}] read failed: ${error}`);
        if (String(error).includes('NOGROUP')) {
          await this.ensureGroup().catch((e) => this.logger.error(`recreating group failed: ${e}`));
        }
        await sleep(1000);
        continue;
      }
      for (const [id, fields] of entries) {
        while (this.inFlight.size >= this.maxConcurrency() && !this.stopped) {
          await Promise.race(this.inFlight);
        }
        // entries read but not dispatched stay pending; another instance claims them later
        if (this.stopped) return;
        this.spawn(decodeEvent(id, fields));
      }
    }
  }

  /** Takes over events that a dead (or stuck) instance read but never acknowledged. */
  private async claimTick(): Promise<void> {
    const free = this.freeSlots();
    if (this.claiming || this.stopped || free === 0) return;
    this.claiming = true;
    try {
      const { command, instanceName, claimIdleMs, batchSize } = this.ctx;
      const reply = (await command.call(
        'XAUTOCLAIM',
        this.key,
        this.consumerName,
        instanceName,
        claimIdleMs,
        '0-0',
        'COUNT',
        Math.min(batchSize, free),
      )) as unknown[];
      const claimed = (Array.isArray(reply[1]) ? reply[1] : []) as Array<
        [id: string, fields: string[] | null]
      >;
      const fresh = claimed.filter(([id]) => !this.activeIds.has(id));
      if (fresh.length === 0) return;

      // XAUTOCLAIM does not report delivery counts; they become the attempt number
      const pipeline = command.pipeline();
      for (const [id] of fresh) pipeline.call('XPENDING', this.key, this.consumerName, id, id, 1);
      const counts = (await pipeline.exec()) ?? [];

      fresh.forEach(([id, fields], index) => {
        if (!Array.isArray(fields)) {
          // trimmed away while pending: nothing left to deliver, clear it from the pending list
          command.call('XACK', this.key, this.consumerName, id).catch(() => {});
          return;
        }
        const pending = counts[index]?.[1] as unknown[] | undefined;
        const deliveries = Number((pending?.[0] as unknown[] | undefined)?.[3] ?? 1) || 1;
        const event = decodeEvent(id, fields);
        this.spawn({ ...event, attempt: Math.max(event.attempt, deliveries) });
      });
    } finally {
      this.claiming = false;
    }
  }

  /** Picks up retries whose backoff has elapsed. */
  private async retryTick(): Promise<void> {
    const free = this.freeSlots();
    if (this.retrying || this.stopped || free === 0) return;
    this.retrying = true;
    try {
      const { command, claimIdleMs, batchSize } = this.ctx;
      const members = (await runScript(
        command,
        RETRY_CLAIM,
        [this.retryKey],
        [claimIdleMs, Math.min(batchSize, free)],
      )) as string[];
      for (const member of members ?? []) {
        const stored = JSON.parse(member) as {
          id: string;
          event: string;
          payload: string;
          headers: string;
          attempt: number;
        };
        this.spawn({
          id: stored.id,
          eventName: stored.event,
          payloadJson: stored.payload,
          headersJson: stored.headers,
          attempt: stored.attempt,
          timestamp: Number(stored.id.split('-')[0]),
          retryMember: member,
        });
      }
    } finally {
      this.retrying = false;
    }
  }

  private async handle(delivery: Delivery): Promise<void> {
    this.activeIds.add(delivery.id);
    try {
      await this.process(delivery);
    } catch (error) {
      // infrastructure failure (e.g. Redis unreachable): the entry or its lease is recovered later
      this.logger.error(`[${this.label}] processing ${delivery.id} failed: ${error}`);
    } finally {
      this.activeIds.delete(delivery.id);
    }
  }

  private async process(delivery: Delivery): Promise<void> {
    let payload: unknown;
    let headers: Record<string, string>;
    try {
      if (delivery.eventName === '') throw new Error('entry has no "event" field');
      payload = JSON.parse(delivery.payloadJson);
      headers = JSON.parse(delivery.headersJson);
    } catch (error) {
      await this.deadLetter(delivery, `undecodable event: ${(error as Error).message}`);
      return;
    }

    const matching = [...this.subscriptions].filter(
      (s) => s.eventName === undefined || s.eventName === delivery.eventName,
    );
    if (matching.length === 0) {
      await this.complete(delivery);
      return;
    }

    const policy = resolveRetry(this.ctx.retry, matching.find((s) => s.retry !== undefined)?.retry);
    if (delivery.attempt > policy.attempts) {
      await this.deadLetter(
        delivery,
        `exceeded ${policy.attempts} delivery attempts without completing ` +
          '(an instance probably crashed or timed out while handling it)',
      );
      return;
    }

    const dedup = matching.some((s) => s.dedup);
    if (dedup) {
      const state = await this.dedupBegin(delivery.id);
      if (state === 'done') {
        await this.complete(delivery);
        return;
      }
      if (state === 'busy') {
        // another instance is handling it right now and acknowledges it itself; if it dies, the
        // lease expires and the event is claimed again
        this.logger.debug(`[${this.label}] ${delivery.id} is being handled elsewhere`);
        return;
      }
    }

    const meta: EventMetadata = {
      id: delivery.id,
      topicName: this.topicName,
      eventName: delivery.eventName,
      consumerName: this.consumerName,
      instanceName: this.ctx.instanceName,
      streamKey: this.key,
      timestamp: delivery.timestamp,
      attempt: delivery.attempt,
      headers,
    };
    const results = await Promise.allSettled(
      matching.map((s) => s.semaphore.run(() => s.handler(payload, meta))),
    );
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

    if (failures.length === 0) {
      if (dedup) await this.dedupDone(delivery.id);
      await this.complete(delivery);
      return;
    }

    for (const { reason } of failures) {
      this.logger.error(
        `[${this.label}] handler failed for ${delivery.eventName} (${delivery.id}, attempt ${delivery.attempt}): ${reason}`,
      );
    }
    if (dedup) await this.ctx.command.call('DEL', this.dedupKey(delivery.id));

    const reason = failures[0]?.reason;
    const message = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? (reason.stack ?? '') : '';
    if (delivery.attempt >= policy.attempts) {
      await this.deadLetter(delivery, message, stack);
    } else {
      await this.scheduleRetry(delivery, backoffDelay(policy, delivery.attempt));
    }
  }

  private dedupKey(eventId: string): string {
    return `${this.ctx.prefix}:dedup:${this.topicName}:${this.consumerName}:${eventId}`;
  }

  /**
   * `acquired`: we may run the handlers. `done`: already processed successfully. `busy`: another
   * instance holds a live lease on it. The lease lasts `claimIdleMs`, like a pending entry.
   */
  private async dedupBegin(eventId: string): Promise<'acquired' | 'done' | 'busy'> {
    const { command, claimIdleMs } = this.ctx;
    const key = this.dedupKey(eventId);
    const set = await command.call('SET', key, 'p', 'NX', 'PX', claimIdleMs);
    if (set === 'OK') return 'acquired';
    return (await command.call('GET', key)) === 'd' ? 'done' : 'busy';
  }

  private async dedupDone(eventId: string): Promise<void> {
    await this.ctx.command.call('SET', this.dedupKey(eventId), 'd', 'EX', this.ctx.dedupTtlSeconds);
  }

  /** Releases a delivery that needs no further work. */
  private async complete(delivery: Delivery): Promise<void> {
    const { command } = this.ctx;
    try {
      if (delivery.retryMember !== undefined) {
        await command.call('ZREM', this.retryKey, delivery.retryMember);
      } else {
        await command.call('XACK', this.key, this.consumerName, delivery.id);
      }
    } catch (error) {
      // it will be delivered again: at-least-once
      this.logger.error(`[${this.label}] ack failed for ${delivery.id}: ${error}`);
    }
  }

  private async scheduleRetry(delivery: Delivery, delayMs: number): Promise<void> {
    const member = JSON.stringify({
      id: delivery.id,
      event: delivery.eventName,
      payload: delivery.payloadJson,
      headers: delivery.headersJson,
      attempt: delivery.attempt,
    });
    await runScript(
      this.ctx.command,
      RETRY_SCHEDULE,
      [this.retryKey, this.key],
      [
        this.consumerName,
        delivery.retryMember === undefined ? delivery.id : '',
        delivery.retryMember ?? '',
        member,
        delayMs,
      ],
    );
    this.logger.debug(`[${this.label}] retry of ${delivery.id} in ${delayMs}ms`);
  }

  private async deadLetter(delivery: Delivery, error: string, stack = ''): Promise<void> {
    await runScript(
      this.ctx.command,
      DEAD_LETTER,
      [this.retryKey, this.key, this.dlqKey],
      [
        this.consumerName,
        delivery.retryMember === undefined ? delivery.id : '',
        delivery.retryMember ?? '',
        this.ctx.dlqMaxLen,
        'event',
        delivery.eventName,
        'payload',
        delivery.payloadJson,
        'headers',
        delivery.headersJson,
        'consumer',
        this.consumerName,
        'attempt',
        String(delivery.attempt),
        'error',
        error,
        'stack',
        stack,
        'originalId',
        delivery.id,
        'failedAt',
        String(Date.now()),
      ],
    );
    this.logger.warn(
      `[${this.label}] ${delivery.eventName} (${delivery.id}) moved to the dead-letter stream: ${error}`,
    );
  }
}
