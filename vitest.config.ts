import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      'virtual:caretcms/providers': fileURLToPath(
        new URL('./tests/unit/stubs/runtime-providers.ts', import.meta.url),
      ),
      'virtual:caretcms/schemas': fileURLToPath(
        new URL('./tests/unit/stubs/schemas.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    benchmark: {
      include: ['tests/bench/**/*.bench.ts'],
    },
    environment: 'node',
  },
});
