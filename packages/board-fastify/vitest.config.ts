import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // the sibling sources, so no build is needed first (the UI files still come from board-ui/dist)
    alias: {
      '@eventlane/core': new URL('../core/src/index.ts', import.meta.url).pathname,
      '@eventlane/board-api': new URL('../board-api/src/index.ts', import.meta.url).pathname,
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
