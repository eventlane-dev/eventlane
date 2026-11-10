import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

// Relative asset URLs: the page is served under whatever path the host mounts the board on.
export default defineConfig({
  base: './',
  plugins: [preact()],
  build: { outDir: 'dist/app', emptyOutDir: true, sourcemap: false },
  server: {
    // `pnpm dev` talks to a board mounted by a running server (set BOARD_URL), e.g. the example
    proxy: { '/api': process.env.BOARD_URL ?? 'http://localhost:3000/admin/events' },
  },
});
