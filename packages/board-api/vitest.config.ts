import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // test the sources of the sibling package, so no build is needed first
    alias: { '@eventlane/core': new URL('../core/src/index.ts', import.meta.url).pathname },
  },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
