# @eventlane/board-fastify

Mounts the EventLane dashboard into a Fastify app: `app.register(createBoard({ buses }).plugin, { prefix })`.

> Part of [EventLane](../../README.md).

## Build and test

```bash
pnpm --filter @eventlane/board-fastify build
pnpm --filter @eventlane/board-fastify dev        # rebuild on every change (watch mode)
pnpm --filter @eventlane/board-fastify test      # needs Redis and the built UI (`pnpm --filter @eventlane/board-ui build`)
pnpm --filter @eventlane/board-fastify typecheck
```


## Documentation

- [Dashboard: getting started](../../docs/dashboard/getting-started.md#fastify)
