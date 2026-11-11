# @eventlane/board-fastify

A web dashboard for [EventLane](https://www.npmjs.com/package/@eventlane/core), as a Fastify plugin: browse the events of a topic, see where each consumer stands, retry or purge dead letters and replay history.

> **The dashboard has no login of its own.** Mount it behind your authentication (middleware or the `authorize` option) or on an internal network. It is read-only unless you pass `readOnly: false`.

## Install

```bash
npm install @eventlane/board-fastify @eventlane/core fastify ioredis
```

## Use it

```ts
import { createBoard } from '@eventlane/board-fastify';
import { EventLaneBus } from '@eventlane/core';
import Fastify from 'fastify';

const bus = new EventLaneBus({ redisUrl: process.env.REDIS_URL!, consumerName: 'my-app' });
const app = Fastify();

await app.register(createBoard({ buses: bus, authorize: (req) => isAdmin(req) }).plugin, {
  prefix: '/admin/events',
});
await app.listen({ port: 3000 });
```

Open `http://localhost:3000/admin/events/`.

## Documentation

- [Dashboard: getting started](https://eventlane-dev.github.io/eventlane/dashboard/getting-started#fastify) and [options](https://eventlane-dev.github.io/eventlane/dashboard/getting-started#options)

## License

MIT. Source and issues: [github.com/eventlane-dev/eventlane](https://github.com/eventlane-dev/eventlane).
