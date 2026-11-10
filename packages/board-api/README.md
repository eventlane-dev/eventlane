# @eventlane/board-api

The framework-neutral JSON API of the EventLane dashboard: `createBoardApi(options).handle(request)` answers `{ status, body }` for topics, events, consumers and dead letters, and for the write actions. It has no HTTP framework dependency; the adapters translate requests.

> Part of [EventLane](https://github.com/eventlane-dev/eventlane).

## Install

```bash
npm install @eventlane/board-api @eventlane/core
```

## Build and test

```bash
pnpm --filter @eventlane/board-api build
pnpm --filter @eventlane/board-api dev        # rebuild on every change (watch mode)
pnpm --filter @eventlane/board-api test      # needs Redis; it runs against the sources of `@eventlane/core`
pnpm --filter @eventlane/board-api typecheck
```

To build an adapter for another framework, see "Other frameworks" in the dashboard docs.

## Documentation

- [Dashboard: getting started](https://eventlane-dev.github.io/eventlane/dashboard/getting-started) (options), [HTTP API](https://eventlane-dev.github.io/eventlane/dashboard/api)
