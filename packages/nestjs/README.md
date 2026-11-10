# @eventlane/nestjs

NestJS integration for EventLane: `EventLaneModule` (`forRoot`, `forRootAsync`, `forFeature`), the injectable `EventLaneEmitter`, `@InjectLaneEmitter` and `@OnLaneEvent`.

> Part of [EventLane](https://github.com/eventlane-dev/eventlane).

## Install

```bash
npm install @eventlane/nestjs @eventlane/core ioredis
```

## Build and test

```bash
pnpm --filter @eventlane/nestjs build
pnpm --filter @eventlane/nestjs dev        # rebuild on every change (watch mode)
pnpm --filter @eventlane/nestjs test      # needs Redis; it runs against the sources of `@eventlane/core`
pnpm --filter @eventlane/nestjs typecheck
```

A runnable app: [examples/nestjs](https://github.com/eventlane-dev/eventlane/tree/main/examples/nestjs).

## Documentation

- [Getting started](https://eventlane-dev.github.io/eventlane/nestjs/getting-started), [Module, emitters and handlers](https://eventlane-dev.github.io/eventlane/nestjs/guide), [Configuration](https://eventlane-dev.github.io/eventlane/nestjs/configuration)
