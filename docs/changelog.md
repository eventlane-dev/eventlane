# Changelog

Notable changes for people who use EventLane. Versions of all packages move together.

## 0.4.0

- **Dashboard modes and presets.** The board has three modes (`mode` option): `'readonly'` (the default), `'presets'` (read, and send the events you define, nothing else) and `'full'` (every action, as `readOnly: false` was). The server enforces the mode, so a restricted board cannot be bypassed with a hand-made request. **Presets** are ready-made events (name, optional icon and description, topic, event name, payload, headers) with a button on the topic's Events tab: no typing, no typos. In `'presets'` mode the event is read-only and only the preset's id is sent; in `'full'` mode you can edit it before sending. A new `preset.send` action reaches `authorize` and `onWrite`. See [Options and security](dashboard/options.md#modes); a runnable demo is in `examples/board` (`BOARD_MODE`).
- **Upgrade note.** `readOnly: false` still works (it means `mode: 'full'`). `GET /api/config` now answers `{ mode, hidePayloads, buses, presets }`: the `readOnly` field is gone, so a script that read it should read `mode` instead.
- `@eventlane/core` and `@eventlane/nestjs` have no code changes; their version only follows the others.

## 0.3.0

- **Validation with schemas (optional).** Give events a schema (zod, valibot, ArkType or any [Standard Schema](https://standardschema.dev)) with the `schemas` option and payloads are checked on `emit` (it rejects with `ValidationError`) and on receive (an invalid event goes to the dead letters without retries, or is skipped with `onInvalid: 'drop'`). `validate` chooses where. Without `schemas` nothing changes. See [Validation](core/validation.md); a runnable example with zod is in `examples/validation`.
- **Dead letters have a `reason`.** `'validation'` when the payload failed its schema, `'error'` otherwise (a new `reason` field in the dead-letter entry; older entries count as `error`). The dashboard marks the first kind as **invalid payload**.

## 0.2.0

- **Typed events (optional).** `EventLaneBus<AppEvents>`, `TopicEmitter<UserEvents>`, `EventLaneEmitter<AppEvents>` and `@OnLaneEvent<UserEvents>('user.created')` check topic names, event names and payloads at compile time. Existing untyped code keeps compiling. See [Typed events](core/typed-events.md) and [in NestJS](nestjs/typed-events.md); a runnable app is in `examples/typed`.

## 0.1.1

Documentation only, no code changes: package pages on npm now describe how to use each package, the packages have search keywords, and the documentation has a quick start, recipes and troubleshooting.

## 0.1.0

First release.

- **`@eventlane/core`**: topics, independent consumers, at-least-once delivery, retries with backoff, dead letters, crash recovery, deduplication and idempotent emits, replay, retention (the latest 1 000 000 events per topic by default), stats and lag, inspection API.
- **`@eventlane/nestjs`**: `EventLaneModule` (`forRoot`, `forRootAsync`, `forFeature`), `@OnLaneEvent`, `@InjectLaneEmitter`, injectable `EventLaneEmitter`. Works with NestJS 10, 11 and 12.
- **Dashboard**: `@eventlane/board-express`, `@eventlane/board-fastify`, `@eventlane/board-nestjs` (with `@eventlane/board-api` and `@eventlane/board-ui`): browse topics and events, follow consumers, retry or purge dead letters, replay history. Read-only by default.
- Needs Redis 6.2 or newer with persistence on.

## Upgrading

The API may still change between minor versions while the major version is 0. Pin the version you use (`"@eventlane/core": "0.4.0"`) and read this page before you upgrade. Upgrade all `@eventlane/*` packages of an app together.
