import { defineConfig } from 'vitest/config';

/**
 * Rules tests are separate from the unit suite: they need the Firestore
 * emulator running, so they must not be part of the fast `npm test` loop.
 */
export default defineConfig({
  test: {
    include: ['tests/rules/**/*.test.ts'],
    // Rules tests share one emulator and clear it between cases, so they
    // cannot run in parallel with each other.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
