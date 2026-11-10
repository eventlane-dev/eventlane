import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // two copies of vite are installed (vitest's and VitePress's), so the plugin types differ
  plugins: [swc.vite() as never],
  resolve: {
    // the sibling sources, so no build is needed first (the UI files still come from board-ui/dist)
    alias: {
      '@eventlane/core': new URL('../core/src/index.ts', import.meta.url).pathname,
      '@eventlane/nestjs': new URL('../nestjs/src/index.ts', import.meta.url).pathname,
      '@eventlane/board-api': new URL('../board-api/src/index.ts', import.meta.url).pathname,
      '@eventlane/board-express': new URL('../board-express/src/index.ts', import.meta.url)
        .pathname,
      '@eventlane/board-fastify': new URL('../board-fastify/src/index.ts', import.meta.url)
        .pathname,
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
