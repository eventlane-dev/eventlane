import type {
  ConsumerEventStatus,
  EventLaneBus,
  PendingEvent,
  RetryingEvent,
  TopicStats,
} from '@eventlane/core';

/** What a request wants to do; passed to `authorize` and to `onWrite`. */
export type BoardAction =
  | 'read'
  | 'dlq.retry'
  | 'dlq.purge'
  | 'consumer.replay'
  | 'consumer.remove'
  | 'topic.delete'
  | 'event.emit';

/** The header every write request must carry (it makes browsers refuse cross-site writes). */
export const CSRF_HEADER = 'x-eventlane-board';

/** A request in a framework-neutral shape; the adapters build it from their own request. */
export interface BoardRequest {
  method: string;
  /** Path relative to the API root, e.g. `/topics/orders/events`. */
  path: string;
  query?: Record<string, string | string[] | undefined>;
  /** Request headers (names are matched case-insensitively). */
  headers?: Record<string, string | string[] | undefined>;
  /** The parsed JSON body of a write. */
  body?: unknown;
  /** The host's own request object, handed to `authorize` untouched. */
  raw?: unknown;
  /** Who is asking (an IP address or a user id): the rate limit counts per client. */
  client?: string;
}

export interface BoardResponse {
  status: number;
  body: unknown;
  /** Extra response headers (for example `Retry-After`). */
  headers?: Record<string, string>;
}

/** What `redact` receives and returns: the parts of an event that may hold sensitive data. */
export interface RedactableEvent {
  topicName: string;
  eventName: string;
  payload: unknown;
  headers: Record<string, string>;
}

export interface BoardOptions {
  /**
   * The bus (or buses) to show. A single bus is named `default`, an array `bus-1`, `bus-2`, ...,
   * and an object uses its keys as names.
   */
  buses: EventLaneBus | EventLaneBus[] | Record<string, EventLaneBus>;
  /** Default: `true`: every write is refused. Writes need an explicit `false`. */
  readOnly?: boolean;
  /** Called for every request, with the host's request object. Return `false` to answer 403. */
  authorize?: (request: unknown, action: BoardAction) => boolean | Promise<boolean>;
  /** Applied to every payload and header set before it leaves the server. */
  redact?: (event: RedactableEvent) => RedactableEvent | Promise<RedactableEvent>;
  /** Never send payloads (events and dead letters show metadata only). */
  hidePayloads?: boolean;
  /** Payloads larger than this many characters of JSON are not sent. Default: 262144. */
  maxPayloadBytes?: number;
  /** Max requests handled at once, so open tabs cannot load Redis. Default: 8. */
  concurrency?: number;
  /**
   * Requests allowed per client (`BoardRequest.client`, the IP address in the adapters) in a time
   * window; over it the board answers 429. Default: 100 per 10 seconds. `false` turns it off.
   */
  rateLimit?: false | { max?: number; windowMs?: number };
  /**
   * Origins (e.g. `https://admin.example.com`) allowed to send write requests, besides the host
   * the board is served from. Only needed behind a proxy that rewrites the `Host` header.
   */
  allowedOrigins?: string[];
  /** Called after every successful write, for an audit log. */
  onWrite?: (entry: BoardWriteEntry) => void | Promise<void>;
  /** Called with unexpected errors (answered as 500). */
  onError?: (error: unknown) => void;
}

export interface BoardWriteEntry {
  action: Exclude<BoardAction, 'read'>;
  bus: string;
  topicName: string;
  consumerName?: string;
  /** What was done: ids, filters, counts. */
  detail: Record<string, unknown>;
  /** The host's own request object. */
  request: unknown;
}

export interface BoardConfig {
  readOnly: boolean;
  hidePayloads: boolean;
  /** Names of the mounted buses; the first is the default. */
  buses: string[];
}

export interface TopicOverview {
  topicName: string;
  /** Events stored in the topic. */
  length: number;
  deadLetters: number;
  consumers: number;
  /** Sums over all consumers. */
  lag: number;
  pending: number;
  retrying: number;
  /** Timestamps (ms) of the oldest and newest stored event. */
  oldest: number | null;
  newest: number | null;
  /** Lag, pending events or dead letters need a look. */
  needsAttention: boolean;
}

export interface TopicsResponse {
  bus: string;
  topics: TopicOverview[];
}

export interface TopicResponse {
  bus: string;
  topic: TopicStats;
}

/** An event in a list: metadata and a short preview, never the whole payload. */
export interface EventSummary {
  id: string;
  eventName: string;
  timestamp: number;
  preview: string;
  /** Length of the payload as JSON. */
  size: number;
  payloadHidden: boolean;
}

export interface EventsResponse {
  events: EventSummary[];
  /** Pass as `cursor` for the next page; null at the end. */
  next: string | null;
  /** With `search`: how many events were looked at to fill this page. */
  scanned?: number;
}

export interface EventDetail {
  id: string;
  topicName: string;
  eventName: string;
  timestamp: number;
  headers: Record<string, string>;
  payload: unknown;
  size: number;
  /** The payload was hidden (`hidePayloads`). */
  payloadHidden: boolean;
  /** The payload was too large to send (`maxPayloadBytes`). */
  payloadTruncated: boolean;
}

export interface EventStatusResponse {
  /** Null when the event is not in the topic (never existed or was trimmed). */
  event: EventDetail | null;
  consumers: ConsumerEventStatus[];
}

export interface PendingResponse {
  events: PendingEvent[];
}

export interface RetryingResponse {
  events: RetryingEvent[];
}

export interface DeadLetterSummary {
  id: string;
  eventName: string;
  consumerName: string;
  attempt: number;
  error: string;
  originalId: string;
  failedAt: number;
  preview: string;
  size: number;
  payloadHidden: boolean;
}

export interface DeadLettersResponse {
  entries: DeadLetterSummary[];
  next: string | null;
  /** All dead letters of the topic (unfiltered). */
  total: number;
}

export interface DeadLetterDetail extends DeadLetterSummary {
  topicName: string;
  stack: string;
  headers: Record<string, string>;
  payload: unknown;
  payloadTruncated: boolean;
}

export interface DeadLetterResponse {
  deadLetter: DeadLetterDetail;
}

export interface ErrorResponse {
  error: string;
}

export interface RetryResponse {
  /** Dead letters re-delivered to the consumers that failed them. */
  retried: number;
}

export interface PurgeResponse {
  /** Dead letters deleted. */
  purged: number;
}

export interface ReplayResponse {
  /** False for a preview (`dryRun`). */
  applied: boolean;
  /** Events the consumer will (or would) read again. */
  affected: number;
  /** The count stopped at its limit: there are more. */
  capped: boolean;
}

export interface RemoveConsumerResponse {
  removed: boolean;
}

export interface DeleteTopicResponse {
  deleted: boolean;
}

export interface EmitResponse {
  /** Id of the event that was stored. */
  id: string;
}
