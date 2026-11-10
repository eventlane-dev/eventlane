import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node20',
  external: [
    '@eventlane/core',
    '@eventlane/nestjs',
    '@eventlane/board-api',
    '@eventlane/board-express',
    '@eventlane/board-fastify',
    '@nestjs/common',
    '@nestjs/core',
    'reflect-metadata',
    'rxjs',
  ],
});
