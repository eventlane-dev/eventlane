# HTTP API

Mounted under `/api` by the adapters. Responses are typed: the types are exported from `@eventlane/board-api`.

JSON over HTTP, used by the web UI and available to scripts. Reads are `GET`. Writes (`POST` and `DELETE`, see [Write routes](#write-routes)) are refused with `403 { "error": "the board is read-only" }` unless the board was created with `readOnly: false`.

Common to all routes:

- **Bus**: `?bus=<name>` selects a bus (default: the first). An unknown name is `404`.
- **Rate limit**: each client (the IP address in the adapters) may send `rateLimit.max` requests per `rateLimit.windowMs` (100 per 10 s by default, a token bucket); over it the answer is `429 { "error": "too many requests, slow down" }` with a `Retry-After` header (seconds). It applies before everything else, including `authorize`.
- **Authorization**: the host's `authorize(request, action)` hook runs next (`'read'` for reads, a specific action for each write); `false` is `403 { "error": "forbidden" }`.
- **Errors** are `{ "error": "..." }` with status `400` (bad parameter or name), `404` (not found), `500` (unexpected, no details).
- **Cache**: `Cache-Control: no-store`.
- **Privacy**: payloads and headers go through `redact` and `hidePayloads`. List responses contain a short `preview` and the payload's `size`, never the whole payload.
- **Paging**: lists take `limit` (1 to 100, default 50) and return `next`, a cursor that you pass back as `cursor`; `next` is `null` at the end. Filtering is bounded (the core's `maxScan`), so a page can be short while `next` is still set.

## Routes

### `GET /config`

`{ readOnly, hidePayloads, buses: string[] }`.

### `GET /topics`

Overview of every topic: `{ bus, topics: TopicOverview[] }` where each topic is `{ topicName, length, deadLetters, consumers, lag, pending, retrying, oldest, newest, needsAttention }`. `lag`, `pending` and `retrying` are sums over the consumers; `oldest` and `newest` are timestamps in ms (or `null`).

### `GET /topics/:topic`

`{ bus, topic }` with the core's `TopicStats`, including each consumer's `instanceDetails` (`instanceName`, `pending`, `idleMs`). `404` if the topic does not exist.

### `GET /topics/:topic/events`

`{ events: EventSummary[], next }` with `EventSummary = { id, eventName, timestamp, preview, size, payloadHidden }`.

| Query | Meaning |
|---|---|
| `limit` | Page size, 1 to 100. |
| `cursor` | The `next` of the previous page. |
| `eventName` | Only events with this name. |
| `reverse` | `false` for oldest first; default is newest first. |
| `from`, `to` | Inclusive range: an event id or a timestamp in ms. |
| `search` | Only events whose name, payload or headers contain this text (case-insensitive). Bounded: at most 10 000 events are looked at per request; the answer has `scanned` (how many) and `next` to continue. It matches what the board would show (after `redact`) and is refused with `400` while `hidePayloads` is on. |

### `GET /topics/:topic/events/:id`

One event and where it stands for every consumer: `{ event, consumers }`. `event` is `{ id, topicName, eventName, timestamp, headers, payload, size, payloadHidden, payloadTruncated }`, or `null` if the event is no longer in the topic. `consumers` is a list of `{ consumerName, state, ... }` with `state` one of `not-read`, `pending`, `retrying`, `dead-letter`, `done` (see [Where one event stands](../core/operations.md#where-one-event-stands)).

### `GET /topics/:topic/consumers/:consumer/pending`

`{ events: PendingEvent[] }`: events delivered and not acknowledged, oldest first, each `{ id, eventName, instanceName, idleMs, deliveries, timestamp }`. Query: `limit`, `after` (an event id), `instance` (only events held by that instance).

### `GET /topics/:topic/consumers/:consumer/retrying`

`{ events: RetryingEvent[] }`: failed events waiting for a retry, soonest first, each `{ id, eventName, attempt, dueAt, timestamp }`. Query: `limit`, `offset`.

### `GET /topics/:topic/dlq`

`{ entries: DeadLetterSummary[], next, total }`, newest first. An entry is `{ id, eventName, consumerName, attempt, error, originalId, failedAt, preview, size, payloadHidden }`; `total` is all dead letters of the topic. Query: `limit`, `cursor`, `consumer`, `eventName`, `reverse` (`false` for oldest first).

### `GET /topics/:topic/dlq/:id`

`{ deadLetter }`: the entry above plus `topicName`, `stack`, `headers`, `payload` and `payloadTruncated`. `404` if it is not there.

## Write routes

Available only with `readOnly: false`. Every write must carry:

- the header `X-EventLane-Board: 1`;
- no foreign origin: when the request has an `Origin` header it must be the board's own host (or in `allowedOrigins`), and `Sec-Fetch-Site: cross-site` is refused;
- for a body, `Content-Type: application/json` (at most 100 KB).

Otherwise the answer is `403`. Each route checks `authorize(request, action)` with its action and, after success, calls `onWrite`. A bulk action needs an explicit scope, so an empty body can never mean "everything".

### `POST /topics/:topic/events`

Action `event.emit`. Stores a test event in the topic; every consumer of the topic receives it. Body: `{ eventName: string, payload?: any JSON, headers?: Record<string, string> }` (`eventName` 1 to 200 characters, at most 20 headers). Answers `{ id }`.

### `POST /topics/:topic/dlq/retry`

Action `dlq.retry`. Sends dead letters back to the consumers that failed them, with a fresh attempt count. Body: `{ ids?: string[], consumer?: string, eventName?: string, all?: boolean }`. Give `ids` (at most 1000), or a filter, or `all: true`. Answers `{ retried: number }`.

### `POST /topics/:topic/dlq/purge`

Action `dlq.purge`. Deletes dead letters; the same body as retry. Answers `{ purged: number }`.

### `POST /topics/:topic/consumers/:consumer/replay`

Action `consumer.replay`. Moves the consumer's read position. Body: `{ from, dryRun? }` where `from` is `"0"` (the beginning), `"$"` (the end, skipping everything stored), an event id, or a timestamp in ms (number or digits). With `dryRun: true` nothing changes and the answer only says what would happen. Answers `{ applied: boolean, affected: number, capped: boolean }`: how many events the consumer reads again (counted up to 10 000, then `capped`).

### `DELETE /topics/:topic/consumers/:consumer?confirm=<consumer>`

Action `consumer.remove`. Removes the consumer's read position, pending list and retries; the events stay. `confirm` must equal the consumer's name, otherwise `400`. Answers `{ removed: boolean }`.

### `DELETE /topics/:topic?confirm=<topic>`

Action `topic.delete`. Deletes the topic with its dead letters, retries and idempotency keys. `confirm` must equal the topic's name, otherwise `400`. Answers `{ deleted: true }`.

## Example

```bash
curl -s http://localhost:3000/admin/events/api/topics/orders/events?limit=2 \
  -H 'Cookie: ...'
```

```json
{
  "events": [
    { "id": "1762725960000-0", "eventName": "order.placed", "timestamp": 1762725960000,
      "preview": "{\"orderId\":42,\"total\":99}", "size": 26, "payloadHidden": false }
  ],
  "next": "1762725960000-0"
}
```

```bash
# retry every dead letter of one consumer (writes enabled)
curl -s -X POST 'http://localhost:3000/admin/events/api/topics/orders/dlq/retry' \
  -H 'X-EventLane-Board: 1' -H 'Content-Type: application/json' \
  -d '{"consumer":"billing"}'
# {"retried":12}
```
