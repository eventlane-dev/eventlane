# @eventlane/board-ui

The web UI of the [EventLane](https://www.npmjs.com/package/@eventlane/core) dashboard, as static files. You normally do not install it: `@eventlane/board-express` and `@eventlane/board-fastify` already include it.

## Install

```bash
npm install @eventlane/board-ui
```

Only needed to serve the UI from your own adapter. The package exports `uiDirectory`, the folder with the built app; serve its files, and its `index.html` with a `<base href>` set to the mount path. It talks to the API with relative URLs, so it works under any path.

## Documentation

- [Dashboard overview](https://eventlane-dev.github.io/eventlane/dashboard/overview), [Other frameworks](https://eventlane-dev.github.io/eventlane/dashboard/getting-started#other-frameworks)

## License

MIT. Source and issues: [github.com/eventlane-dev/eventlane](https://github.com/eventlane-dev/eventlane).
