import { defineConfig } from 'tsup';

// Only the tiny entry that tells adapters where the built UI lives; the UI itself is built by Vite.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  target: 'node20',
  shims: true,
});
