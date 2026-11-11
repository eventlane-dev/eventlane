# @eventlane/board-api

The framework-neutral JSON API behind the [EventLane](https://www.npmjs.com/package/@eventlane/core) dashboard. Use it to build a dashboard adapter for a framework that has none; for Express, Fastify or NestJS use the ready-made adapters instead.

## Install

```bash
npm install @eventlane/board-api @eventlane/core
```

## Use it

```ts
import { createBoardApi } from '@eventlane/board-api';

const api = createBoardApi({ buses: bus, readOnly: true });

// translate your framework's request, then write the answer; handle never throws
const { status, body } = await api.handle({ method: 'GET', path: '/topics', query: {}, raw: request });
```

It covers topics, events, consumers and dead letters, with rate limiting, payload redaction and protection of write actions built in.

## Documentation

- [HTTP API](https://eventlane-dev.github.io/eventlane/dashboard/api), [Other frameworks](https://eventlane-dev.github.io/eventlane/dashboard/getting-started#other-frameworks)

## License

MIT. Source and issues: [github.com/eventlane-dev/eventlane](https://github.com/eventlane-dev/eventlane).
