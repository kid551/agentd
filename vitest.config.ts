import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'packages/agentd/tests/**/*.test.ts',
      'packages/dsh-superagent/tests/**/*.test.ts',
      'scripts/**/*.test.ts',
    ],
    testTimeout: 15000,
  },
})
