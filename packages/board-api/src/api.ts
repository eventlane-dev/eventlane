import { type DeadLetter, type EventLaneBus, EventLaneError } from '@eventlane/core';
import { BoardError } from './errors';
import { createRateLimiter } from './rate-limit';
import {
  type BoardAction,
  type BoardConfig,
  type BoardOptions,
  type BoardRequest,
  type BoardResponse,
  CSRF_HEADER,
  type DeadLetterDetail,
  type DeadLetterResponse,
  type DeadLetterSummary,
  type DeadLettersResponse,
  type DeleteTopicResponse,
  type EmitResponse,
  type EventDetail,
  type EventStatusResponse,
  type EventSummary,
  type EventsResponse,
  type PendingResponse,
  type PurgeResponse,
  type RedactableEvent,
  type RemoveConsumerResponse,
  type ReplayResponse,
  type RetryingResponse,
  type RetryResponse,
  type TopicOverview,
  type TopicResponse,
  type TopicsResponse,
} from './types';

const DEFAULT_MAX_PAYLOAD = 262_144;
const PREVIEW_LENGTH = 200;
const MAX_LIMIT = 100;

export interface BoardApi {
  /** Answers one request; never throws. */
  handle(request: BoardRequest): Promise<BoardResponse>;
  readonly config: BoardConfig;
}

const reply = (status: number, body: unknown, headers?: Record<string, string>): BoardResponse =>
  headers ? { status, body, headers } : { status, body };

/** How many events one search request may look at. */
const SEARCH_SCAN_LIMIT = 10_000;
const SEARCH_CHUNK = 200;

/** Limits how many requests run at once; the rest wait their turn. */
function limiter(max: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

function resolveBuses(buses: BoardOptions['buses']): Map<string, EventLaneBus> {
  const map = new Map<string, EventLaneBus>();
  if (Array.isArray(buses)) {
    for (const [i, bus] of buses.entries()) map.set(`bus-${i + 1}`, bus);
  } else if (typeof (buses as EventLaneBus).emit === 'function')
    map.set('default', buses as EventLaneBus);
  else for (const [name, bus] of Object.entries(buses)) map.set(name, bus);
  if (map.size === 0) throw new Error('createBoardApi: at least one bus is required');
  return map;
}

/** Maps over items with a few in flight at a time. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

export function createBoardApi(options: BoardOptions): BoardApi {
  const buses = resolveBuses(options.buses);
  const readOnly = options.readOnly !== false;
  const hidePayloads = options.hidePayloads === true;
  const maxPayload = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD;
  const run = limiter(options.concurrency ?? 8);
  const rateLimit = options.rateLimit === false ? undefined : (options.rateLimit ?? {});
  if (rateLimit !== undefined) {
    const { max = 100, windowMs = 10_000 } = rateLimit;
    if (!Number.isInteger(max) || max < 1 || !Number.isInteger(windowMs) || windowMs < 1) {
      throw new Error('createBoardApi: rateLimit.max and rateLimit.windowMs must be integers >= 1');
    }
  }
  const limiterFor =
    rateLimit && createRateLimiter(rateLimit.max ?? 100, rateLimit.windowMs ?? 10_000);
  const config: BoardConfig = { readOnly, hidePayloads, buses: [...buses.keys()] };

  const first = (query: BoardRequest['query'], name: string): string | undefined => {
    const value = query?.[name];
    return Array.isArray(value) ? value[0] : value || undefined;
  };

  const integer = (
    query: BoardRequest['query'],
    name: string,
    fallback: number,
    min: number,
    max: number,
  ): number => {
    const text = first(query, name);
    if (text === undefined) return fallback;
    const value = Number(text);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new BoardError(400, `${name} must be an integer between ${min} and ${max}`);
    }
    return value;
  };

  /** What may leave the server for an event: redacted, maybe hidden or too large. */
  async function view(event: RedactableEvent) {
    const json = JSON.stringify(event.payload ?? null) ?? 'null';
    if (hidePayloads) {
      const { headers } = options.redact
        ? await options.redact({ ...event, payload: null })
        : event;
      return {
        payload: null,
        headers,
        size: json.length,
        hidden: true,
        truncated: false,
        preview: '',
      };
    }
    const redacted = options.redact ? await options.redact(event) : event;
    const redactedJson = JSON.stringify(redacted.payload ?? null) ?? 'null';
    const truncated = redactedJson.length > maxPayload;
    return {
      payload: truncated ? null : redacted.payload,
      headers: redacted.headers,
      size: redactedJson.length,
      hidden: false,
      truncated,
      preview:
        redactedJson.length > PREVIEW_LENGTH
          ? `${redactedJson.slice(0, PREVIEW_LENGTH)}…`
          : redactedJson,
    };
  }

  async function eventDetail(
    topicName: string,
    event: {
      id: string;
      eventName: string;
      timestamp: number;
      payload: unknown;
      headers: Record<string, string>;
    },
  ): Promise<EventDetail> {
    const v = await view({
      topicName,
      eventName: event.eventName,
      payload: event.payload,
      headers: event.headers,
    });
    return {
      id: event.id,
      topicName,
      eventName: event.eventName,
      timestamp: event.timestamp,
      headers: v.headers,
      payload: v.payload,
      size: v.size,
      payloadHidden: v.hidden,
      payloadTruncated: v.truncated,
    };
  }

  async function deadLetterSummary(
    letter: DeadLetter,
  ): Promise<DeadLetterSummary & { _view: Awaited<ReturnType<typeof view>> }> {
    const v = await view({
      topicName: letter.topicName,
      eventName: letter.eventName,
      payload: letter.payload,
      headers: letter.headers,
    });
    return {
      id: letter.id,
      eventName: letter.eventName,
      consumerName: letter.consumerName,
      attempt: letter.attempt,
      error: letter.error,
      originalId: letter.originalId,
      failedAt: letter.failedAt,
      preview: v.preview,
      size: v.size,
      payloadHidden: v.hidden,
      _view: v,
    };
  }

  async function overview(bus: EventLaneBus, topicName: string): Promise<TopicOverview> {
    const [stats, oldest, newest] = await Promise.all([
      bus.stats(topicName),
      bus.readPage(topicName, { count: 1 }),
      bus.readPage(topicName, { count: 1, reverse: true }),
    ]);
    const sum = (pick: (c: (typeof stats.consumers)[number]) => number) =>
      stats.consumers.reduce((total, c) => total + pick(c), 0);
    const lag = sum((c) => c.lag);
    const pending = sum((c) => c.pending);
    return {
      topicName,
      length: stats.length,
      deadLetters: stats.deadLetters,
      consumers: stats.consumers.length,
      lag,
      pending,
      retrying: sum((c) => c.retrying),
      oldest: oldest.events[0]?.timestamp ?? null,
      newest: newest.events[0]?.timestamp ?? null,
      needsAttention: lag > 0 || pending > 0 || stats.deadLetters > 0,
    };
  }

  /**
   * Finds events whose name, payload or headers contain `search` (case-insensitive). It looks at
   * what the board would show, after `redact`, so a search cannot reveal a hidden value, and it
   * looks at no more than SEARCH_SCAN_LIMIT events: `next` says where to continue.
   */
  async function searchEvents(
    bus: EventLaneBus,
    topicName: string,
    search: string,
    page: {
      count: number;
      reverse: boolean;
      eventName: string | undefined;
      after: string | undefined;
      from: string | undefined;
      to: string | undefined;
    },
  ): Promise<EventsResponse> {
    const needle = search.toLowerCase();
    const found: EventSummary[] = [];
    let cursor = page.after;
    let scanned = 0;
    let next: string | null = null;

    while (found.length < page.count && scanned < SEARCH_SCAN_LIMIT) {
      const chunk = await bus.readPage(topicName, {
        count: SEARCH_CHUNK,
        reverse: page.reverse,
        eventName: page.eventName,
        after: cursor,
        from: page.from,
        to: page.to,
      });
      for (const event of chunk.events) {
        scanned++;
        const v = await view({
          topicName,
          eventName: event.eventName,
          payload: event.payload,
          headers: event.headers,
        });
        const text = `${event.eventName} ${JSON.stringify(v.payload ?? null)} ${JSON.stringify(v.headers)}`;
        cursor = event.id;
        if (text.toLowerCase().includes(needle)) {
          found.push({
            id: event.id,
            eventName: event.eventName,
            timestamp: event.timestamp,
            preview: v.preview,
            size: v.size,
            payloadHidden: v.hidden,
          });
        }
        if (found.length >= page.count || scanned >= SEARCH_SCAN_LIMIT) {
          next = event.id;
          break;
        }
      }
      if (next !== null) break;
      if (chunk.next === undefined) break; // the range is exhausted
    }
    return { events: found, next, scanned };
  }

  async function route(request: BoardRequest): Promise<BoardResponse> {
    const segments = request.path.split('/').filter(Boolean).map(decodeURIComponent);
    const query = request.query;
    const [head, topicName, section, subject, leaf] = segments;

    if (head === 'config' && segments.length === 1) return reply(200, config);

    if (head !== 'topics') throw new BoardError(404, 'not found');

    const busName = first(query, 'bus') ?? config.buses[0] ?? 'default';
    const bus = buses.get(busName);
    if (!bus) throw new BoardError(404, `unknown bus "${busName}"`);

    // /topics
    if (topicName === undefined) {
      const names = await bus.topics();
      const topics = await mapLimit(names, 8, (name) => overview(bus, name));
      return reply(200, { bus: busName, topics } satisfies TopicsResponse);
    }

    // /topics/:topic
    if (section === undefined) {
      const topic = await bus.stats(topicName, { instances: true });
      if (topic.length === 0 && topic.deadLetters === 0 && topic.consumers.length === 0) {
        throw new BoardError(404, `topic "${topicName}" not found`);
      }
      return reply(200, { bus: busName, topic } satisfies TopicResponse);
    }

    // /topics/:topic/events[/:id]
    if (section === 'events' && leaf === undefined) {
      if (subject === undefined) {
        const search = first(query, 'search');
        if (search !== undefined) {
          if (hidePayloads) {
            throw new BoardError(400, 'search is not available while payloads are hidden');
          }
          return reply(
            200,
            await searchEvents(bus, topicName, search, {
              count: integer(query, 'limit', 50, 1, MAX_LIMIT),
              reverse: first(query, 'reverse') !== 'false',
              eventName: first(query, 'eventName'),
              after: first(query, 'cursor'),
              from: first(query, 'from'),
              to: first(query, 'to'),
            }),
          );
        }
        const page = await bus.readPage(topicName, {
          count: integer(query, 'limit', 50, 1, MAX_LIMIT),
          reverse: first(query, 'reverse') !== 'false',
          eventName: first(query, 'eventName'),
          after: first(query, 'cursor'),
          from: first(query, 'from'),
          to: first(query, 'to'),
        });
        const events = await Promise.all(
          page.events.map(async (event) => {
            const v = await view({
              topicName,
              eventName: event.eventName,
              payload: event.payload,
              headers: event.headers,
            });
            return {
              id: event.id,
              eventName: event.eventName,
              timestamp: event.timestamp,
              preview: v.preview,
              size: v.size,
              payloadHidden: v.hidden,
            };
          }),
        );
        return reply(200, { events, next: page.next ?? null } satisfies EventsResponse);
      }
      const status = await bus.eventStatus(topicName, subject);
      return reply(200, {
        event: status.event ? await eventDetail(topicName, status.event) : null,
        consumers: status.consumers,
      } satisfies EventStatusResponse);
    }

    // /topics/:topic/consumers/:consumer/(pending|retrying)
    if (section === 'consumers' && subject !== undefined && leaf !== undefined) {
      if (leaf === 'pending') {
        const events = await bus.pending(topicName, subject, {
          count: integer(query, 'limit', 50, 1, MAX_LIMIT),
          after: first(query, 'after'),
          instanceName: first(query, 'instance'),
        });
        return reply(200, { events } satisfies PendingResponse);
      }
      if (leaf === 'retrying') {
        const events = await bus.retries(topicName, subject, {
          count: integer(query, 'limit', 50, 1, MAX_LIMIT),
          offset: integer(query, 'offset', 0, 0, Number.MAX_SAFE_INTEGER),
        });
        return reply(200, { events } satisfies RetryingResponse);
      }
    }

    // /topics/:topic/dlq[/:id]
    if (section === 'dlq' && leaf === undefined) {
      if (subject === undefined) {
        const page = await bus.dlq.page(topicName, {
          count: integer(query, 'limit', 50, 1, MAX_LIMIT),
          reverse: first(query, 'reverse') !== 'false',
          consumerName: first(query, 'consumer'),
          eventName: first(query, 'eventName'),
          after: first(query, 'cursor'),
        });
        const entries = await Promise.all(
          page.entries.map(async (letter) => {
            const { _view, ...summary } = await deadLetterSummary(letter);
            return summary;
          }),
        );
        return reply(200, {
          entries,
          next: page.next ?? null,
          total: await bus.dlq.count(topicName),
        } satisfies DeadLettersResponse);
      }
      const letter = await bus.dlq.get(topicName, subject);
      if (!letter) throw new BoardError(404, 'dead letter not found');
      const { _view: v, ...summary } = await deadLetterSummary(letter);
      const detail: DeadLetterDetail = {
        ...summary,
        topicName,
        stack: letter.stack,
        headers: v.headers,
        payload: v.payload,
        payloadTruncated: v.truncated,
      };
      return reply(200, { deadLetter: detail } satisfies DeadLetterResponse);
    }

    throw new BoardError(404, 'not found');
  }

  const lower = (headers: BoardRequest['headers']): Record<string, string | undefined> => {
    const result: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(headers ?? {})) {
      result[name.toLowerCase()] = Array.isArray(value) ? value[0] : value;
    }
    return result;
  };

  /**
   * Browsers send cookies on cross-site requests, so a write must prove it comes from the board:
   * it needs a custom header (which a foreign page cannot add without a CORS preflight, and this
   * server answers none) and, when the browser sends an `Origin`, that origin must be ours.
   */
  function assertSameOrigin(request: BoardRequest): void {
    const headers = lower(request.headers);
    if (headers[CSRF_HEADER] !== '1') {
      throw new BoardError(403, `write requests need the "${CSRF_HEADER}: 1" header`);
    }
    if (headers['sec-fetch-site'] === 'cross-site') {
      throw new BoardError(403, 'cross-site request refused');
    }
    const origin = headers.origin;
    if (origin === undefined) return;
    let host: string | undefined;
    try {
      host = new URL(origin).host;
    } catch {
      // "null" and malformed origins are not ours
    }
    const allowed = host !== undefined && host === headers.host;
    if (!allowed && !options.allowedOrigins?.includes(origin)) {
      throw new BoardError(403, 'cross-origin request refused');
    }
  }

  const record = (body: unknown): Record<string, unknown> => {
    if (body === undefined || body === null) return {};
    if (typeof body !== 'object' || Array.isArray(body)) {
      throw new BoardError(400, 'the request body must be a JSON object');
    }
    return body as Record<string, unknown>;
  };
  const optionalString = (body: Record<string, unknown>, name: string): string | undefined => {
    const value = body[name];
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string') throw new BoardError(400, `${name} must be a string`);
    return value;
  };
  const optionalIds = (body: Record<string, unknown>): string[] | undefined => {
    const value = body.ids;
    if (value === undefined || value === null) return undefined;
    if (
      !Array.isArray(value) ||
      value.length > 1000 ||
      value.some((id) => typeof id !== 'string')
    ) {
      throw new BoardError(400, 'ids must be an array of at most 1000 dead-letter ids');
    }
    return value as string[];
  };

  /** How many events a replay from `from` makes the consumer read again (bounded). */
  async function replayImpact(bus: EventLaneBus, topicName: string, from: string | number) {
    if (from === '$') return { affected: 0, capped: false };
    if (from === '0' || from === '0-0') {
      return { affected: (await bus.stats(topicName)).length, capped: false };
    }
    let affected = 0;
    let after: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await bus.readPage(topicName, { from, count: 1000, after });
      affected += result.events.length;
      if (result.next === undefined) return { affected, capped: false };
      after = result.next;
    }
    return { affected, capped: true };
  }

  async function writeRoute(request: BoardRequest, method: string): Promise<BoardResponse> {
    const segments = request.path.split('/').filter(Boolean).map(decodeURIComponent);
    const [head, topicName, section, subject, leaf] = segments;
    if (head !== 'topics' || topicName === undefined) throw new BoardError(404, 'not found');

    const busName = first(request.query, 'bus') ?? config.buses[0] ?? 'default';
    const bus = buses.get(busName);
    if (!bus) throw new BoardError(404, `unknown bus "${busName}"`);

    const guard = async (action: BoardAction) => {
      if (options.authorize && !(await options.authorize(request.raw, action))) {
        throw new BoardError(403, 'forbidden');
      }
    };
    const audit = async (
      action: Exclude<BoardAction, 'read'>,
      detail: Record<string, unknown>,
      consumerName?: string,
    ) => {
      try {
        await options.onWrite?.({
          action,
          bus: busName,
          topicName,
          consumerName,
          detail,
          request: request.raw,
        });
      } catch (error) {
        options.onError?.(error);
      }
    };
    const body = record(request.body);

    // POST /topics/:topic/events: store a test event
    if (method === 'POST' && section === 'events' && subject === undefined) {
      await guard('event.emit');
      const eventName = body.eventName;
      if (typeof eventName !== 'string' || eventName === '' || eventName.length > 200) {
        throw new BoardError(400, 'eventName must be a string of 1 to 200 characters');
      }
      const headers = body.headers ?? {};
      if (
        typeof headers !== 'object' ||
        headers === null ||
        Array.isArray(headers) ||
        Object.keys(headers).length > 20 ||
        Object.values(headers).some((value) => typeof value !== 'string')
      ) {
        throw new BoardError(400, 'headers must be an object of at most 20 string values');
      }
      const id = await bus.emit(topicName, eventName, body.payload ?? null, {
        headers: headers as Record<string, string>,
      });
      await audit('event.emit', { eventName, id });
      return reply(200, { id } satisfies EmitResponse);
    }

    // POST /topics/:topic/dlq/retry   and   POST /topics/:topic/dlq/purge
    if (method === 'POST' && section === 'dlq' && leaf === undefined) {
      const ids = optionalIds(body);
      const consumer = optionalString(body, 'consumer');
      const eventName = optionalString(body, 'eventName');
      const everything = body.all === true;
      if (subject === 'retry') {
        await guard('dlq.retry');
        if (!ids && !consumer && !eventName && !everything) {
          throw new BoardError(400, 'say what to retry: ids, consumer, eventName or all: true');
        }
        const retried = await bus.dlq.retryMany(topicName, {
          ids,
          consumerName: consumer,
          eventName,
        });
        await audit('dlq.retry', { ids, consumer, eventName, all: everything, retried }, consumer);
        return reply(200, { retried } satisfies RetryResponse);
      }
      if (subject === 'purge') {
        await guard('dlq.purge');
        if (!ids && !consumer && !eventName && !everything) {
          throw new BoardError(400, 'say what to delete: ids, consumer, eventName or all: true');
        }
        const purged = await bus.dlq.purge(topicName, { ids, consumerName: consumer, eventName });
        await audit('dlq.purge', { ids, consumer, eventName, all: everything, purged }, consumer);
        return reply(200, { purged } satisfies PurgeResponse);
      }
    }

    // POST /topics/:topic/consumers/:consumer/replay
    if (
      method === 'POST' &&
      section === 'consumers' &&
      subject !== undefined &&
      leaf === 'replay'
    ) {
      await guard('consumer.replay');
      const from = body.from;
      const valid =
        typeof from === 'number'
          ? Number.isInteger(from) && from >= 0
          : typeof from === 'string' && (from === '$' || /^\d+(-\d+)?$/.test(from));
      if (!valid) {
        throw new BoardError(400, 'from must be "0", "$", an event id or a timestamp in ms');
      }
      const position = from as string | number;
      const impact = await replayImpact(bus, topicName, position);
      const apply = body.dryRun !== true;
      if (apply) {
        await bus.replay(topicName, { consumerName: subject, from: position });
        await audit('consumer.replay', { from: position, ...impact }, subject);
      }
      return reply(200, { applied: apply, ...impact } satisfies ReplayResponse);
    }

    // DELETE /topics/:topic/consumers/:consumer?confirm=<consumer>
    if (
      method === 'DELETE' &&
      section === 'consumers' &&
      subject !== undefined &&
      leaf === undefined
    ) {
      await guard('consumer.remove');
      if (first(request.query, 'confirm') !== subject) {
        throw new BoardError(400, 'confirm must be the name of the consumer');
      }
      const removed = await bus.removeConsumer(topicName, subject);
      await audit('consumer.remove', { removed }, subject);
      return reply(200, { removed } satisfies RemoveConsumerResponse);
    }

    // DELETE /topics/:topic?confirm=<topic>
    if (method === 'DELETE' && section === undefined) {
      await guard('topic.delete');
      if (first(request.query, 'confirm') !== topicName) {
        throw new BoardError(400, 'confirm must be the name of the topic');
      }
      await bus.deleteTopic(topicName, { confirm: true });
      await audit('topic.delete', {});
      return reply(200, { deleted: true } satisfies DeleteTopicResponse);
    }

    throw new BoardError(404, 'not found');
  }

  return {
    config,
    async handle(request) {
      try {
        if (limiterFor) {
          const verdict = limiterFor.take(request.client ?? 'unknown');
          if (!verdict.allowed) {
            return reply(
              429,
              { error: 'too many requests, slow down' },
              {
                'Retry-After': String(Math.max(1, Math.ceil(verdict.retryAfterMs / 1000))),
              },
            );
          }
        }
        const method = request.method.toUpperCase();
        if (method !== 'GET' && method !== 'HEAD') {
          if (readOnly) return reply(403, { error: 'the board is read-only' });
          assertSameOrigin(request);
          return await run(() => writeRoute(request, method));
        }
        if (options.authorize && !(await options.authorize(request.raw, 'read'))) {
          return reply(403, { error: 'forbidden' });
        }
        return await run(() => route(request));
      } catch (error) {
        if (error instanceof BoardError) return reply(error.status, { error: error.message });
        if (error instanceof EventLaneError) return reply(400, { error: error.message });
        options.onError?.(error);
        return reply(500, { error: 'internal error' });
      }
    },
  };
}
