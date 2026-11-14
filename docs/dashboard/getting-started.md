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
> **The dashboard has no login of its own.** Anyone who can open its address can read your event payloads and headers (and change things when `readOnly: false`). Mount it behind your authentication (middleware, or the `authorize` option) or keep it on an internal network. See [Security notes](options.md#security-notes).

## Mount it

Pick the adapter for your framework: [Express](#express), [Fastify](#fastify) or [NestJS](#nestjs). They take the same [options](options.md).

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

`BoardModule` takes the [options](options.md) plus:

| Option | Default | Description |
|---|---|---|
| `route` | `/admin/events` | Where the board is served. |
| `buses` | the `EventLaneModule` bus | Show other buses instead (or too). |
| `middleware` | none | Express platform only: middleware run before the board, such as authentication. On Fastify use `authorize` or a hook of your own. |

`BoardModule.forRootAsync({ imports, inject, useFactory })` builds the options from other providers, like `EventLaneModule.forRootAsync`. The module mounts the board when it initializes, using the Express or Fastify instance of your application, so it needs an HTTP application (not just an application context). Nest guards do not apply to the board, because it is mounted on the HTTP server and not as a controller; protect it with `authorize` or `middleware`.

## Next

- [Using the board](using.md): what each screen shows and what the actions do.
- [Options and security](options.md): `readOnly`, `authorize`, `redact` and the rest.

## Other frameworks

For a framework without an adapter use `@eventlane/board-api` directly: `createBoardApi(options).handle({ method, path, query, raw })` answers `{ status, body }` and never throws, and `@eventlane/board-ui` exports `uiDirectory`, the folder with the static app (serve its files, and its `index.html` with a `<base href>` set to the mount path). The [HTTP API](api.md) is documented.
