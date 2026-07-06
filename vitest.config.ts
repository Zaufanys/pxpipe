import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Several e2e tests render tens of thousands of chars to real PNGs, which is
    // CPU-bound and can brush past Vitest's 5s default on slower/CI runners (a
    // genuine ~6s render would flake). Give the suite headroom; a truly hung test
    // still fails, just later.
    testTimeout: 20_000,
  },
});
