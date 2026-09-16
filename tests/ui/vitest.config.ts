import path from 'path';
import { defineConfig } from 'vitest/config';

/**
 * Vitest config for the component-logic tests.
 *
 * Two deltas from the root config, both forced by the same thing: these tests
 * import `.tsx` modules to exercise the pure functions that live beside the
 * components, and the repo tsconfig sets `jsx: "preserve"` (which Next needs),
 * so Vite hands unparsed JSX to Node unless the transform is told otherwise.
 *
 *   oxc.jsx.runtime  compile JSX instead of preserving it
 *   include          `*.ui-test.ts`, deliberately NOT `*.test.ts`, so the root
 *                    `vitest run` sweep does not pick these up and fail on the
 *                    same transform. Fold them in by adding the oxc option to
 *                    the root vitest.config.ts and renaming the files.
 *
 * Run: npx vitest run --config tests/ui/vitest.config.ts
 */
export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '../../src'),
    },
  },
  test: {
    include: ['tests/ui/**/*.ui-test.ts'],
  },
});
