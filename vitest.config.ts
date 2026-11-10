import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      { find: 'virtual:caretcms/providers', replacement: fileURLToPath(new URL('./tests/unit/stubs/runtime-providers.ts', import.meta.url)) },
      { find: 'virtual:caretcms/schemas', replacement: fileURLToPath(new URL('./tests/unit/stubs/schemas.ts', import.meta.url)) },
      { find: 'virtual:caretcms/page-content', replacement: fileURLToPath(new URL('./tests/unit/stubs/page-content.ts', import.meta.url)) },
      // The editor's messages module is built by the asset route; tests get English.
      { find: /^\.\/messages\.js$/, replacement: fileURLToPath(new URL('./tests/unit/stubs/editor-messages.ts', import.meta.url)) },
    ],
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    benchmark: {
      include: ['tests/bench/**/*.bench.ts'],
    },
    environment: 'node',
  },
});
