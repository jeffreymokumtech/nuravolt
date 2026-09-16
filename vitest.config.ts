import path from 'path';
import { defineConfig } from 'vitest/config';

/**
 * Minimal vitest config: resolve the `@/` path alias so tests can import
 * source modules (the demo-conversation fixture tests). The HTTP contract
 * tests are unaffected.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
