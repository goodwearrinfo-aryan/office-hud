import { defineConfig } from 'vitest/config';

  export default defineConfig({
    test: {
      // Only the React component tests. The ../server/test suite is run by
      // `npm test` under node:test -- feeding it to vitest as well made all 79
      // of those files fail in a runner they were never written for, and it is
      // what kept this suite at zero passing.
      include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
      globals: true,
      environment: 'jsdom',
      setupFiles: ['./vitest.setup.ts'],
    },
  });
