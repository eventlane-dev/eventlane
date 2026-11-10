import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // SWC emits the decorator metadata Nest needs for constructor injection by type
  // two copies of vite are installed (vitest's and VitePress's), so the plugin types differ
  plugins: [swc.vite() as never],
  resolve: {
    // test the sources of the sibling package, so no build is needed first
    alias: { '@eventlane/core': new URL('../core/src/index.ts', import.meta.url).pathname },
  },
  test: {
    include: ['test/**/*.test.ts'],
    passWithNoTests: true,
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
