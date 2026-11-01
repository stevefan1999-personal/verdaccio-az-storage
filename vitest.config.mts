import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'tests/e2e/**'],
    restoreMocks: true,
    unstubEnvs: true,
  },
});
