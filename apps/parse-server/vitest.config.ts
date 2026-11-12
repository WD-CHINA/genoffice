import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    // Teardown must cover the service's 30-second shutdown deadline.
    hookTimeout: 35_000,
  },
})
