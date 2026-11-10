# AGENTS.md

Guidance for AI coding agents (and humans) working in this repository.

## What this is

EventLane: a persistent event bus on Redis Streams for Node.js and NestJS, plus a dashboard for it, as a pnpm monorepo (see the package list in `README.md`). What is not built, still open or not verified is in `OPEN.md` at the root; how things work is in `docs/`.

## Source of truth

1. `docs/` is the user documentation and must match the code. When behavior changes, change the docs **in the same change**. It contains no decisions, plans or status notes.
2. `OPEN.md` (root) lists only what is not done or not known yet. When an item is done or decided, delete it: the result belongs in `docs/` or the code. Do not keep decision logs, and do not add open items to `docs/` or to new markdown files.
3. `docs/core/redis-data-model.md` must match the actual Redis keys and entry fields.
4. The docs are a VitePress site in three sections: `docs/core/` (the framework-independent library and its concepts), `docs/nestjs/` and `docs/dashboard/`. Keep each page in its section: core pages never depend on Nest, and Nest-specific options live in `docs/nestjs/configuration.md`. A new page must also be added to the sidebar in `docs/.vitepress/config.mts`. Run `pnpm docs:build` after docs changes: it fails on dead links.

## Vocabulary (use consistently, defined in `docs/core/concepts.md`)

- **`topicName`**: a channel of related events (`users`). Stored as a Redis stream at `<prefix>:<topicName>`, default prefix `events`.
- **`eventName`**: the kind of event inside a topic (`user.created`), a field in the stream entry.
- **`consumerName`**: a logical receiver (`notifications`); a Redis consumer group. In Nest it belongs to a **module** (`forFeature({ consumerName })`).
- **`instanceName`**: one running process of a consumer; a Redis consumer; generated (`hostname-pid-random`).
- **payload**: the JSON data of an event. Handler signature is `(payload, meta)`.
- **TopicEmitter**: emitter bound to one topic, injected by `@InjectLaneEmitter(topicName)`; `emit(eventName, payload)`.
- **EventLaneEmitter**: general emitter, injected by class with no decorator; `emit(topicName, eventName, payload)`.
- Do not use the words *domain*, *group* or *stream* in the public API or user docs; Redis terms live only in `docs/core/redis-data-model.md` and `docs/core/concepts.md#mapping-to-redis-and-kafka`.
- Redis connection config takes exactly one of `redisUrl` (string) or `redis` (connection object or ioredis client).

## Layout

```
packages/core/      @eventlane/core
packages/nestjs/    @eventlane/nestjs
packages/board-api/     @eventlane/board-api: framework-neutral JSON API of the dashboard
packages/board-ui/      @eventlane/board-ui: Preact + Vite single-page app, built to static files
packages/board-express/ @eventlane/board-express: Express adapter (router with API and UI)
packages/board-fastify/ @eventlane/board-fastify: Fastify adapter (plugin; serves the UI files itself)
packages/board-nestjs/  @eventlane/board-nestjs: `BoardModule`, mounts the Express or Fastify adapter on the Nest HTTP instance
examples/express/       plain Express app with the core, no dashboard (runnable: `pnpm --filter @eventlane/example-express start`)
examples/nestjs/        monolith with two consumers on one topic and the dashboard (runnable: `pnpm --filter @eventlane/example-nestjs start`)
examples/board/         Express app with demo traffic and the board (runnable: `pnpm --filter @eventlane/example-board start`)
docs/                   user documentation, a VitePress site: core/, nestjs/, dashboard/
OPEN.md                  what is not built, open or not verified
```

## Commands (pnpm)

```bash
pnpm install
pnpm redis:up        # docker compose: container "eventlane-redis" on localhost:6390 (Redis 7, AOF on, noeviction; named after the project so it cannot collide with other Redis containers; EVENTLANE_REDIS_PORT changes the port)
pnpm build           # tsup, ESM + CJS + types, in every package (run it before typecheck: nestjs and the example resolve @eventlane/core through its dist)
pnpm typecheck       # tsc --noEmit
pnpm test            # vitest (the UI tests run in happy-dom); needs Redis, honours REDIS_URL (default redis://localhost:6390, the compose Redis)
REDIS_PROTOCOL=2 pnpm test   # the same suite on RESP2 (CI runs both)
pnpm --filter <package> dev   # watch mode: rebuild a library on change; examples restart when a package they use is rebuilt
pnpm --filter @eventlane/core bench   # throughput/latency benchmark (build first; needs Redis); numbers live in docs/core/operations.md#performance
pnpm lint            # biome check . (use "pnpm format" to fix formatting)
pnpm docs:dev        # preview the documentation site
pnpm docs:build      # build it (fails on dead links); deployed to GitHub Pages by .github/workflows/docs.yml
```

Tooling notes:
- Development needs Node 22.18+ (tsup, vitest); the published packages target Node 20+.
- TypeScript is pinned to 6.x: TypeScript 7 has no compiler API, which tsup's `.d.ts` generation needs. Revisit when tsup supports it.
- Biome (not ESLint/Prettier) handles lint and formatting; it ignores Markdown.
- Packages are `"private": true`. Do not remove that without the user's go-ahead.
- `@eventlane/nestjs` uses `@swc/core` (tsup and `unplugin-swc` in vitest) so decorator metadata is emitted; library code still uses explicit `@Inject()` tokens. Its tests alias `@eventlane/core` to the sibling sources, so they need no build.
- Biome has `unsafeParameterDecoratorsEnabled` on because Nest code uses parameter decorators.

## Engineering rules

- TypeScript `strict`. No `any` in public API except payloads (`T = any` is intended).
- Core must not import from `@nestjs/*`.
- `ioredis` is a **peer dependency**. Blocking reads (`XREADGROUP BLOCK`) use a dedicated connection; never block the shared one.
- Delivery is **at-least-once**: acknowledge only after the handler succeeds. Never ack before.
- Each running instance needs a unique `instanceName`.
- Redis replies differ between RESP2 and RESP3 (`ioredis` 6 defaults to RESP3, and users may pass their own client). Run raw commands through `client.call(...)` and normalize replies (see `readEntries` in `packages/core/src/internal.ts`); never assume one shape.
- Retries are delivered only to the consumer that failed, from its retry set; never re-`XADD` a retry to the topic (every consumer would receive it again). Retry, dead-letter and lease transitions are single Lua scripts (`packages/core/src/scripts.ts`) so they are atomic.
- Stream ids are unique only within one stream: never key shared state by event id alone, include the topic (as the dedup keys do).
- Never `XGROUP DELCONSUMER` an instance that has pending events: it discards them.
- `packages/core/test/resilience.test.ts` starts, kills and restarts its own `redis-server` on a free port (skipped when the binary is missing; CI installs it).
- Tests run against a **real Redis**, not mocks; the value is in Redis semantics (pending list, claim, trimming). Cover crash recovery, retry/DLQ, fan-out vs load balancing, graceful shutdown.
- Keep the public API small and `EventEmitter`-like. Prefer options over new methods.
- Nest: find handlers with `DiscoveryService`/`MetadataScanner` at bootstrap and read per-module settings from the importing module (see `packages/nestjs/src/explorer.ts`); keep it working on Nest 10, 11 and 12. Reject unsupported setups with a message that names `Class.method`.
- No HTTP server or UI in `@eventlane/core` or `@eventlane/nestjs`. The dashboard is a separate set of packages (see `docs/dashboard/`) that uses only the core's public API; if it needs data the core does not expose, add it to the core API first.
- Dashboard: `board-api` has no HTTP framework dependency (adapters translate requests); every response must pass through the redaction path (`view()` in `api.ts`) so `redact` and `hidePayloads` cannot be bypassed by a new route; reads are bounded (no unbounded scans) and capped (`limit` <= 100). Every write route must: refuse while `readOnly`, pass `assertSameOrigin` (the `X-EventLane-Board` header and origin checks), call `guard(<action>)` for its own action, require an explicit scope (never let an empty body mean everything) or a typed `confirm`, and call `audit` (`onWrite`) after success. The UI uses relative URLs (the adapter injects `<base href>`) so any mount path works. The Express adapter reads `index.html` once and caches it, so restart the server after rebuilding the UI.
- Every request to `board-api` passes the rate limiter first (keyed by `BoardRequest.client`, which adapters set to the client IP), and anything that inspects payloads (lists, details, search) must go through `view()` so `redact` and `hidePayloads` apply; the payload search works on the redacted text on purpose.
- Adapters stay thin: translate the request into a `BoardRequest` (method, path, query, headers, body, the raw request) and write the `BoardResponse`; never duplicate API logic. `board-nestjs` mounts on the HTTP instance in `onModuleInit` (Nest guards do not apply to it); Nest tests that mix packages can fail with two copies of `@nestjs/core` (pnpm peer variants), so keep the same platform dev dependencies in the packages that are loaded together.
- After changing `packages/board-ui`, check it in a browser (`examples/board`); Biome reformats CSS, so verify edits to `style.css` took effect instead of assuming a text replacement matched.

## Language

Code, comments, commit messages, docs and issues are in **English**.

## Working agreements

- Confirm with the user before publishing to npm, creating a public repo, or reserving an npm scope.
- Do not commit or push unless asked.
- When unsure about a product decision, ask the user; once answered, implement it and describe it in `docs/`.
- Do not add markdown files with plans, proposals or notes. Open items go in `OPEN.md`; everything else belongs in the user documentation (`docs/`), a package README, or nowhere.
