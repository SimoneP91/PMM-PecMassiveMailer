import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * SWC instead of esbuild: Vitest's default transformer does not emit decorator
 * metadata, and NestJS dependency injection is built on it.
 */
const swcPlugin = swc.vite({
  jsc: {
    target: 'es2023',
    parser: { syntax: 'typescript', decorators: true },
    transform: { decoratorMetadata: true, legacyDecorator: true },
  },
});

export default defineConfig({
  plugins: [swcPlugin],
  test: {
    globals: false,
    environment: 'node',
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/main.*.ts', 'src/tools/**'],
    },
    projects: [
      {
        test: { name: 'unit', include: ['test/unit/**/*.spec.ts'] },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.spec.ts'],
          // Real Mongo and Greenmail from docker-compose.test.yml
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.spec.ts'],
          globalSetup: ['test/e2e/global-setup.ts'],
          // One mongod for the run, files one after the other: stacks share it.
          fileParallelism: false,
          // In-memory MongoDB: the first run downloads the binary.
          testTimeout: 30_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
