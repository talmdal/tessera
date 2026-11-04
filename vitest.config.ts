import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  // Files outside a folder with its own tsconfig (such as tessera-ui/) still get the automatic JSX runtime
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'shared'),
      '@core': path.resolve(__dirname, 'core'),
      '@tessera/types': path.resolve(__dirname, 'tessera-types/index.ts'),
      '@tessera/ui': path.resolve(__dirname, 'tessera-ui/index.ts')
    }
  },
  test: {
    // Default environment: jsdom for renderer tests
    environment: 'jsdom',
    globals: true,
    clearMocks: false,
    mockReset: false,
    restoreMocks: false,
    setupFiles: ['./tests/setup/setupTests.ts'],
    globalSetup: ['./tests/setup/buildUiFixture.ts'],
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: ['dist', 'node_modules'],

    // Plugins written to temp dirs by tests are loaded with Node's native
    // import(), as Electron does, rather than through Vite's transform pipeline.
    server: {
      deps: {
        external: [/tessera-(modules|userdata)-/]
      }
    },

    // You can use test-specific environments via `testEnvironment` in files
  }
})
