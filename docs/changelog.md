# Changelog

Notable changes for people who use EventLane. Versions of all packages move together.

## 0.1.1

Documentation only, no code changes: package pages on npm now describe how to use each package, the packages have search keywords, and the documentation has a quick start, recipes and troubleshooting.

## 0.1.0

First release.

- **`@eventlane/core`**: topics, independent consumers, at-least-once delivery, retries with backoff, dead-letter stream, crash recovery, deduplication and idempotent emits, replay, retention (the latest 1 000 000 events per topic by default), stats and lag, inspection API.
- **`@eventlane/nestjs`**: `EventLaneModule` (`forRoot`, `forRootAsync`, `forFeature`), `@OnLaneEvent`, `@InjectLaneEmitter`, injectable `EventLaneEmitter`. Works with NestJS 10, 11 and 12.
- **Dashboard**: `@eventlane/board-express`, `@eventlane/board-fastify`, `@eventlane/board-nestjs` (with `@eventlane/board-api` and `@eventlane/board-ui`): browse topics and events, follow consumers, retry or purge dead letters, replay history. Read-only by default.
- Needs Redis 6.2 or newer with persistence on.

## Upgrading

The API may still change between minor versions while the major version is 0. Pin the version you use (`"@eventlane/core": "0.1.1"`) and read this page before you upgrade. Upgrade all `@eventlane/*` packages of an app together.
