# Contributing

Thanks for helping. This file is about working in the repository; how to use EventLane is in the [documentation](https://eventlane-dev.github.io/eventlane/).

Code, comments, commit messages, docs and issues are in English. Repository conventions (also for AI coding agents) are in [AGENTS.md](AGENTS.md).

## Requirements

- Node.js 22.18 or newer (the build and test tooling; the packages themselves target Node 20+)
- [pnpm](https://pnpm.io) 9 (`corepack enable` picks the right version)
- Docker, for the Redis the tests and examples use (or any Redis 6.2+ and a `REDIS_URL`)

## Getting started

```bash
pnpm install
pnpm redis:up      # starts the "eventlane-redis" container on localhost:6390
pnpm build         # builds every package (the order is handled for you)
pnpm test          # runs every test suite against that Redis
```

`pnpm redis:down` stops the container. The Redis is named after the project and listens on port 6390 (only on this machine), so it does not collide with other projects or with a Redis you already run; set `EVENTLANE_REDIS_PORT` to change the port and `REDIS_URL` to test against another Redis.

## Commands

Run these from the repository root; they apply to every package.

| Command | What it does |
|---|---|
| `pnpm build` | Builds all packages (tsup, plus Vite for the UI). Build before `typecheck` and before running the examples. |
| `pnpm typecheck` | Type-checks all packages and examples. |
| `pnpm test` | Runs all tests (needs Redis). `REDIS_PROTOCOL=2 pnpm test` runs them on RESP2 as well. |
| `pnpm lint` | Biome check. `pnpm format` fixes formatting. |
| `pnpm docs:dev` / `docs:build` / `docs:preview` | The documentation site: develop, build, serve the build (details below). |

## Development: watch mode

Every library package has a `dev` script that rebuilds it when its sources change (`tsup --watch`), and the examples have a `dev` script (`tsx watch`) that restarts them when their sources **or a rebuilt package they use** change. A typical loop, in two terminals:

```bash
pnpm --filter @eventlane/core dev                   # terminal 1: rebuild core on every change
pnpm --filter @eventlane/example-express dev        # terminal 2: restart the example when core is rebuilt
```

| Package | Dev script | Notes |
|---|---|---|
| `core`, `nestjs`, `board-api`, `board-express`, `board-fastify`, `board-nestjs` | `pnpm --filter <name> dev` | Rebuilds `dist/` on change. Run `pnpm build` once first so everything they depend on is built. |
| `board-ui` | `BOARD_URL=http://localhost:3000/admin/events pnpm --filter @eventlane/board-ui dev` | Vite dev server with hot reload, proxying `/api` to a running board (for example `examples/board`). See [packages/board-ui](packages/board-ui/README.md). |
| examples | `pnpm --filter @eventlane/example-<name> dev` | `start` runs once, `dev` restarts on changes. |

## Running what is built

`pnpm build` produces `dist/` in every package (ESM, CJS and types; the UI in `packages/board-ui/dist/app`). The examples import those built packages, so `pnpm build` is needed before `start` or `dev` and again after you change a package without watch mode. The Express adapter reads the UI's `index.html` once, so restart a running example after rebuilding the UI.

## Documentation site

The docs are a [VitePress](https://vitepress.dev) site in `docs/`.

| Command | What it does |
|---|---|
| `pnpm docs:dev` | Dev server with hot reload: http://localhost:5173 |
| `pnpm docs:build` | Production build into `docs/.vitepress/dist` (fails on dead links) |
| `pnpm docs:preview` | Serves that built site, as it will be deployed: http://localhost:4173 (run `docs:build` first) |

The site is published to GitHub Pages by `.github/workflows/docs.yml` on every push to `main` that changes `docs/`. A project site lives under `/<repository>/`, so the workflow sets `DOCS_BASE` for the build; for a local build under another path use `DOCS_BASE=/my-path/ pnpm docs:build`.

## Building and running one package

Use pnpm's filter with the package name:

```bash
pnpm --filter @eventlane/core build        # build one package
pnpm --filter @eventlane/core test         # test one package
pnpm --filter @eventlane/board-ui dev      # UI dev server (see packages/board-ui/README.md)
```

Packages depend on each other through their built output, so after changing `core` run `pnpm --filter @eventlane/core build` before building or running what depends on it (`pnpm build` does it in the right order). Each package has a short README with its own details.

## Examples

All of them need the Redis from `pnpm redis:up` and a prior `pnpm build`.

| Example | Run | What it shows |
|---|---|---|
| [examples/express](examples/express) | `pnpm --filter @eventlane/example-express start` | A plain Express app using the core: emit from a route, two consumers, your own `stats` route. No dashboard. |
| [examples/board](examples/board) | `pnpm --filter @eventlane/example-board start` | The same idea with demo traffic and the dashboard mounted on `/admin/events`. |
| [examples/nestjs](examples/nestjs) | `pnpm --filter @eventlane/example-nestjs start` | A NestJS app with two consumers of one topic and the dashboard (`BoardModule`). |

## Pull requests

Run `pnpm build`, `pnpm typecheck`, `pnpm test` (also with `REDIS_PROTOCOL=2`), `pnpm lint` and `pnpm docs:build` before you open one. When behavior changes, update the matching page in `docs/` in the same change.
