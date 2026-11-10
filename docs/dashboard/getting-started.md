# Getting started with the dashboard

Runnable apps are in `examples/board` (Express) and `examples/nestjs` (NestJS) in the repository.

The dashboard is a separate set of packages that you mount into an app you already run. It talks to Redis only through the public API of `@eventlane/core`.

| Package | Role |
|---|---|
| `@eventlane/board-express` | The Express adapter: `createBoard()` returns a router with the API and the UI. |
| `@eventlane/board-fastify` | The Fastify adapter: `createBoard()` returns a plugin. |
| `@eventlane/board-nestjs` | `BoardModule` for NestJS (Express or Fastify platform); it finds the bus of `EventLaneModule` itself. |
| `@eventlane/board-api` | The framework-neutral JSON API behind them. Use it directly to build an adapter for another framework. |
| `@eventlane/board-ui` | The single-page web app, shipped as static files. |

> [!WARNING]
> **The dashboard has no login of its own.** Anyone who can open its address can read your event payloads and headers (and change things when `readOnly: false`). Mount it behind your authentication (middleware, or the `authorize` option) or keep it on an internal network. See [Security notes](#security-notes).

## Mount it

Pick the adapter for your framework: [Express](#express), [Fastify](#fastify) or [NestJS](#nestjs). They take the same [options](#options).

### Express

```bash
npm install @eventlane/board-express @eventlane/core express ioredis
```

```ts
import { createBoard } from '@eventlane/board-express';
import { EventLaneBus } from '@eventlane/core';
import express from 'express';

const bus = new EventLaneBus({ redisUrl: process.env.REDIS_URL!, consumerName: 'my-app' });
const app = express();

// authentication first: the board has no login of its own
app.use('/admin/events', requireAdmin);
app.use('/admin/events', createBoard({ buses: bus }).router);

app.listen(3000);
```

Open `http://localhost:3000/admin/events`. The board works on whatever path you mount it, with or without a trailing slash, and behind a reverse proxy that keeps the path.

The bus you give it only needs a Redis connection: it does not have to listen to anything, and it can be the same bus your app uses or a separate one. To watch a different Redis or prefix, create a bus for it.

### Fastify

```bash
npm install @eventlane/board-fastify @eventlane/core fastify ioredis
```

```ts
import { createBoard } from '@eventlane/board-fastify';
import { EventLaneBus } from '@eventlane/core';
import Fastify from 'fastify';

const bus = new EventLaneBus({ redisUrl: process.env.REDIS_URL!, consumerName: 'my-app' });
const app = Fastify();

// a hook of your own (or `authorize`) first: the board has no login of its own
await app.register(createBoard({ buses: bus }).plugin, { prefix: '/admin/events' });
await app.listen({ port: 3000 });
```

The plugin serves the UI files itself (no `@fastify/static` needed) and answers errors in the same JSON shape as the Express adapter. Register it with `prefix: ''` to serve it at the root.

### NestJS

```bash
npm install @eventlane/board-nestjs @eventlane/board-express @eventlane/nestjs @eventlane/core
# on the Fastify platform install @eventlane/board-fastify instead of @eventlane/board-express
```

```ts
import { BoardModule } from '@eventlane/board-nestjs';
import { EventLaneModule } from '@eventlane/nestjs';

@Module({
  imports: [
    EventLaneModule.forRoot({ redisUrl: process.env.REDIS_URL, defaultConsumerName: 'my-app' }),
    // the board shows the bus of EventLaneModule; read-only unless readOnly: false
    BoardModule.forRoot({ route: '/admin/events' }),
  ],
})
export class AppModule {}
```

`BoardModule` takes the [options](#options) plus:

| Option | Default | Description |
|---|---|---|
| `route` | `/admin/events` | Where the board is served. |
| `buses` | the `EventLaneModule` bus | Show other buses instead (or too). |
| `middleware` | none | Express platform only: middleware run before the board, such as authentication. On Fastify use `authorize` or a hook of your own. |

`BoardModule.forRootAsync({ imports, inject, useFactory })` builds the options from other providers, like `EventLaneModule.forRootAsync`. The module mounts the board when it initializes, using the Express or Fastify instance of your application, so it needs an HTTP application (not just an application context). Nest guards do not apply to the board, because it is mounted on the HTTP server and not as a controller; protect it with `authorize` or `middleware`.

## What you see

- **Topics**: every topic with its size, consumers, lag, pending, retrying and dead letters, and the age of the newest event. Topics that need a look (lag, pending or dead letters) are marked and listed first; filter by name or by "needs attention".
- **Topic, Events**: the events of a topic, newest first, 50 at a time with *Load more*. Filter by **event name**, by a **time range** (From and To), or **search** payloads and headers for a text (case-insensitive); **Go to** takes an event id (opens that event) or a timestamp in milliseconds (lists from that moment on). Click an event for its payload, headers and, for **every consumer**, where the event stands: `not-read`, `pending` (and on which instance), `retrying` (with the next retry time), `dead-letter`, or `done`.

  The search is bounded: it looks at no more than 10 000 events per request and says how many it looked at; *Load more* continues it. It searches what the board would show, after `redact`, so it can never find a value that you hide, and it is switched off while `hidePayloads` is on.
- **Topic, Consumers**: each consumer's instances (with how long each has been idle), pending, lag and retrying counts. An instance that holds events and has been idle for over a minute is flagged **probably dead** (the other instances claim its events after `claimIdleMs`, 60 s by default). Click a consumer to list its pending events (who holds them, for how long, how many deliveries; held longer than a minute is highlighted) and its retrying events (attempt, next retry); both load 50 at a time.
- **Topic, Dead letters**: failed events with the consumer, the number of attempts and the error; filter by consumer or event name. Click one for the stack trace, payload and headers.

With writes enabled (see below) the same screens also let you change things.

The page refreshes by polling (every 5 s by default; pick another interval or pause it in the header). While you browse older events the refresh is paused so the list does not move under you. The theme follows your system (light or dark).

## Making changes

The board is read-only until you pass `readOnly: false`; the header then shows a "writes enabled" badge. Every action asks for confirmation first:

| Where | Action | Confirmation |
|---|---|---|
| Events | **Send test event…**: stores an event with a name and a JSON payload (every consumer of the topic receives it) | A dialog that says so; nothing is sent until you press Send |
| Dead letters | **Retry** or **Delete** the selected ones (checkboxes), or all (matching the filters) | A dialog that states what will happen and how many |
| A dead letter | **Retry** or **Delete** it | Retry at once; delete asks |
| Consumers, a consumer | **Replay…**: continue from the beginning, the end (skip), a time or an event id, with a **preview** of how many events it will read again | A dialog; nothing changes until you press Replay |
| Consumers, a consumer | **Remove consumer…**: its read position, pending list and retries (the events stay) | You type the consumer's name |
| Topic | **Delete topic…**: the events, dead letters, retries and idempotency keys | You type the topic's name |

A retried dead letter goes back to the consumer that failed it (not to the others) with a fresh attempt count. Deleting dead letters, removing consumers and deleting topics cannot be undone. Details of what each action does are in the core's [Operations](../core/operations.md) and [Reliability](../core/reliability.md#dead-letter-stream).

The server enforces what the UI shows: a bulk action needs an explicit scope, and removing a consumer or a topic needs its name as `confirm`.

## Options

`createBoard(options)` takes:

| Option | Default | Description |
|---|---|---|
| `buses` | required | A `EventLaneBus`, an array of them (named `bus-1`, `bus-2`, ...) or an object (its keys are the names). With several, the header shows a selector. |
| `readOnly` | `true` | The board refuses every write. Set `false` to allow the actions above. |
| `authorize` | none | `(request, action) => boolean \| Promise<boolean>`, called for every request with the Express request and the action: `'read'`, `'dlq.retry'`, `'dlq.purge'`, `'consumer.replay'`, `'consumer.remove'`, `'topic.delete'` or `'event.emit'`. Return `false` to answer 403. Use it for per-user rules, for example let everyone read but only admins delete. |
| `onWrite` | none | `(entry) => void \| Promise<void>`, called after every successful write for an audit log. `entry` is `{ action, bus, topicName, consumerName?, detail, request }`. A failure in it does not fail the write (it goes to `onError`). |
| `allowedOrigins` | none | Origins (e.g. `https://admin.example.com`) that may send writes besides the host serving the board. Only needed behind a proxy that rewrites the `Host` header. |
| `redact` | none | `(event) => event`, applied to every payload and header set before it leaves the server. `event` is `{ topicName, eventName, payload, headers }`. |
| `hidePayloads` | `false` | Never send payloads at all (lists and details show metadata only). |
| `maxPayloadBytes` | `262144` | Payloads longer than this (as JSON) are not sent; the UI says so. |
| `concurrency` | `8` | How many requests run at once, so a few open tabs cannot load Redis. |
| `rateLimit` | `{ max: 100, windowMs: 10000 }` | Requests allowed per client in a time window (a token bucket, so short bursts are fine); over it the board answers `429` with a `Retry-After` header. The client is the request's IP address (`req.ip`; behind a proxy set Express's `trust proxy` or Fastify's `trustProxy` so it is the real client, not the proxy). `false` turns it off. The UI polls well below the default. |
| `onError` | none | Called with unexpected errors, which are answered as `500 internal error` without details. |

### Keeping payloads private

Payloads can hold personal data. Before exposing the board, decide what it may show:

```ts
createBoard({
  buses: bus,
  redact: (event) => ({
    ...event,
    payload: maskEmails(event.payload),
    headers: { ...event.headers, authorization: '***' },
  }),
  // or: hidePayloads: true
});
```

`redact` runs for events, event details, dead letters and previews alike.

## Security notes

- Put authentication in front of the board (`app.use('/admin/events', requireAdmin)`); `authorize` is for finer rules.
- The board is read-only by default. Keep it that way for anything reachable by many people, and when you enable writes, restrict the destructive actions with `authorize` and record them with `onWrite`.
- Writes are protected against cross-site requests: they must carry the `X-EventLane-Board: 1` header (which a foreign page cannot send without a CORS preflight that the board never answers) and, when the browser sends an `Origin`, it must be the board's own host (or in `allowedOrigins`). Do not add permissive CORS headers in front of the board.
- The page is served with a strict `Content-Security-Policy` (own origin only, no framing) and the API with `Cache-Control: no-store`.
- Stack traces of failed handlers are shown in dead letters; they can reveal paths and internals, so keep the board internal.

## Other frameworks

For a framework without an adapter use `@eventlane/board-api` directly: `createBoardApi(options).handle({ method, path, query, raw })` answers `{ status, body }` and never throws, and `@eventlane/board-ui` exports `uiDirectory`, the folder with the static app (serve its files, and its `index.html` with a `<base href>` set to the mount path). The [HTTP API](api.md) is documented.
