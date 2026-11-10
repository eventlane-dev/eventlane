# @eventlane/board-fastify

Mounts the EventLane dashboard into a Fastify app: `app.register(createBoard({ buses }).plugin, { prefix })`.

> Part of [EventLane](https://github.com/eventlane-dev/eventlane).

## Install

```bash
npm install @eventlane/board-fastify @eventlane/core fastify ioredis
```

## Build and test

```bash
pnpm --filter @eventlane/board-fastify build
pnpm --filter @eventlane/board-fastify dev        # rebuild on every change (watch mode)
pnpm --filter @eventlane/board-fastify test      # needs Redis and the built UI (`pnpm --filter @eventlane/board-ui build`)
pnpm --filter @eventlane/board-fastify typecheck
```


## Documentation

- [Dashboard: getting started](https://eventlane-dev.github.io/eventlane/dashboard/getting-started#fastify)
