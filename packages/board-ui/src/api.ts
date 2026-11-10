import type {
  BoardConfig,
  DeadLetterResponse,
  DeadLettersResponse,
  DeleteTopicResponse,
  EmitResponse,
  EventStatusResponse,
  EventsResponse,
  PendingResponse,
  PurgeResponse,
  RemoveConsumerResponse,
  ReplayResponse,
  RetryingResponse,
  RetryResponse,
  TopicResponse,
  TopicsResponse,
} from '@eventlane/board-api';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Params = Record<string, string | number | boolean | undefined>;

/** GET against the board API. URLs are relative to the page, so any mount path works. */
async function get<T>(path: string, params: Params = {}): Promise<T> {
  const url = new URL(`api/${path}`, document.baseURI);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new ApiError(response.status, body.error ?? response.statusText);
  return body as T;
}

const enc = encodeURIComponent;

export const api = {
  config: () => get<BoardConfig>('config'),
  topics: (bus: string) => get<TopicsResponse>('topics', { bus }),
  topic: (bus: string, topic: string) => get<TopicResponse>(`topics/${enc(topic)}`, { bus }),
  events: (bus: string, topic: string, params: Params) =>
    get<EventsResponse>(`topics/${enc(topic)}/events`, { bus, ...params }),
  event: (bus: string, topic: string, id: string) =>
    get<EventStatusResponse>(`topics/${enc(topic)}/events/${enc(id)}`, { bus }),
  pending: (bus: string, topic: string, consumer: string, params: Params = {}) =>
    get<PendingResponse>(`topics/${enc(topic)}/consumers/${enc(consumer)}/pending`, {
      bus,
      ...params,
    }),
  retrying: (bus: string, topic: string, consumer: string, params: Params = {}) =>
    get<RetryingResponse>(`topics/${enc(topic)}/consumers/${enc(consumer)}/retrying`, {
      bus,
      ...params,
    }),
  deadLetters: (bus: string, topic: string, params: Params) =>
    get<DeadLettersResponse>(`topics/${enc(topic)}/dlq`, { bus, ...params }),
  deadLetter: (bus: string, topic: string, id: string) =>
    get<DeadLetterResponse>(`topics/${enc(topic)}/dlq/${enc(id)}`, { bus }),
};

/** A write: POST or DELETE with the header that proves the request comes from the board. */
async function send<T>(
  method: 'POST' | 'DELETE',
  path: string,
  options: { query?: Params; body?: unknown } = {},
): Promise<T> {
  const url = new URL(`api/${path}`, document.baseURI);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }
  const headers: Record<string, string> = { accept: 'application/json', 'x-eventlane-board': '1' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(url, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new ApiError(response.status, body.error ?? response.statusText);
  return body as T;
}

export interface DeadLetterScope {
  ids?: string[];
  consumer?: string;
  eventName?: string;
  all?: boolean;
}

export const actions = {
  emitEvent: (
    bus: string,
    topic: string,
    body: { eventName: string; payload?: unknown; headers?: Record<string, string> },
  ) => send<EmitResponse>('POST', `topics/${enc(topic)}/events`, { query: { bus }, body }),
  retryDeadLetters: (bus: string, topic: string, scope: DeadLetterScope) =>
    send<RetryResponse>('POST', `topics/${enc(topic)}/dlq/retry`, { query: { bus }, body: scope }),
  purgeDeadLetters: (bus: string, topic: string, scope: DeadLetterScope) =>
    send<PurgeResponse>('POST', `topics/${enc(topic)}/dlq/purge`, { query: { bus }, body: scope }),
  replay: (bus: string, topic: string, consumer: string, from: string | number, dryRun: boolean) =>
    send<ReplayResponse>('POST', `topics/${enc(topic)}/consumers/${enc(consumer)}/replay`, {
      query: { bus },
      body: { from, dryRun },
    }),
  removeConsumer: (bus: string, topic: string, consumer: string) =>
    send<RemoveConsumerResponse>('DELETE', `topics/${enc(topic)}/consumers/${enc(consumer)}`, {
      query: { bus, confirm: consumer },
    }),
  deleteTopic: (bus: string, topic: string) =>
    send<DeleteTopicResponse>('DELETE', `topics/${enc(topic)}`, { query: { bus, confirm: topic } }),
};
