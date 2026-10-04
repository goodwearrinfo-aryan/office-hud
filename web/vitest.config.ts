import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['../server/test/*.test.js', '../server/test/*.test.ts'],
    globals: true,
    environment: 'node',
  },
});