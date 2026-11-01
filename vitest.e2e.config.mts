import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.e2e.test.ts'],
    // Each file starts its own Azurite and Verdaccio; one file at a time keeps memory and timing predictable.
    fileParallelism: false,
    // Each test drives real npm processes, some restart Verdaccio, and the Azure SDK retries an
    // unreachable endpoint for about 16 seconds before Verdaccio can fail.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
