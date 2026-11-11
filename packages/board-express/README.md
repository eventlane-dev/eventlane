# @eventlane/board-express

A web dashboard for [EventLane](https://www.npmjs.com/package/@eventlane/core), mounted into an Express app: browse the events of a topic, see where each consumer stands, retry or purge dead letters and replay history.

> **The dashboard has no login of its own.** Mount it behind your authentication (middleware or the `authorize` option) or on an internal network. It is read-only unless you pass `readOnly: false`.

## Install

```bash
npm install @eventlane/board-express @eventlane/core express ioredis
```

## Use it

```ts
import { createBoard } from '@eventlane/board-express';
import { EventLaneBus } from '@eventlane/core';
import express from 'express';

const bus = new EventLaneBus({ redisUrl: process.env.REDIS_URL!, consumerName: 'my-app' });
const app = express();

app.use('/admin/events', requireAdmin); // your own authentication first
app.use('/admin/events', createBoard({ buses: bus }).router);
app.listen(3000);
```

Open `http://localhost:3000/admin/events/`. Options such as `readOnly`, `authorize`, `redact` and `hidePayloads` are in the docs.

## Documentation

- [Dashboard: getting started](https://eventlane-dev.github.io/eventlane/dashboard/getting-started#express) and [options](https://eventlane-dev.github.io/eventlane/dashboard/getting-started#options)

## License

MIT. Source and issues: [github.com/eventlane-dev/eventlane](https://github.com/eventlane-dev/eventlane).
