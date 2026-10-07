import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['../server/test/*.test.js', '../server/test/*.test.ts', 'src/**/*.test.tsx'],
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
  },
});
