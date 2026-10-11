import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Default environment: jsdom for renderer tests
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup/setupTests.ts'],
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: ['dist', 'node_modules'],

    // You can use test-specific environments via `testEnvironment` in files
  }
})
