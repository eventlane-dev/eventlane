# @eventlane/board-ui

The web UI of the EventLane dashboard: a small Preact single-page app built with Vite to static files. It talks to the board API with relative URLs, so it works under any mount path. The package also exports `uiDirectory`, the folder with the built files, which the adapters serve.

> Part of [EventLane](../../README.md).

## Build and test

```bash
pnpm --filter @eventlane/board-ui build      # tsup (the tiny entry) then vite build into dist/app
pnpm --filter @eventlane/board-ui test       # component tests in happy-dom, no Redis needed
pnpm --filter @eventlane/board-ui typecheck
```

## Develop the UI

Run a server that mounts the board (for example `pnpm --filter @eventlane/example-board start`, which listens on port 3000 by default), then start the Vite dev server pointing at it:

```bash
BOARD_URL=http://localhost:3000/admin/events pnpm --filter @eventlane/board-ui dev
```

The dev server proxies `/api` to that board, so you see real data while editing the UI. After changes, rebuild the UI and restart the example, because the Express adapter reads `index.html` once.

## Documentation

- [Dashboard: overview](../../docs/dashboard/overview.md), [getting started](../../docs/dashboard/getting-started.md)
