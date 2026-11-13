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
      '@tessera/storage-kit': path.resolve(__dirname, 'packages/storage-kit/index.ts'),
      '@tessera/ledger-api': path.resolve(__dirname, 'packages/ledger-api/index.ts'),
      '@tessera/accounts-api': path.resolve(__dirname, 'packages/accounts-api/index.ts'),
      '@tessera/import-api': path.resolve(__dirname, 'packages/import-api/index.ts'),
      '@tessera/export-api': path.resolve(__dirname, 'packages/export-api/index.ts'),
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
    exclude: ['dist', 'node_modules'],

    // Vitest's default is 5 seconds. The slowest tests (dialogs typed into key by key, which re-renders the whole MUI
    // form in jsdom each time, and the pipeline tests on real SQLite files) take 2 to 4.5 seconds on their own, and
    // with the full suite running in parallel some took over 5, a different one each run. A timed-out test also keeps
    // clicking and typing into the next test, which then fails for no reason of its own. 15 seconds leaves room for
    // load while a test that really hangs still fails quickly. Typing without user-event's timers (delay: null) was
    // measured and saved only about 10%, so the time is rendering, not waiting.
    testTimeout: 15_000,

    // Plugins written to temp dirs by tests are loaded with Node's native
    // import(), as Electron does, rather than through Vite's transform pipeline.
    server: {
      deps: {
        external: [/tessera-(modules|userdata)-/]
      }
    },

    // You can use test-specific environments via `testEnvironment` in files

    // Two projects, which differ only in isolation. By default Vitest gives every test file a fresh worker (isolate:
    // true), which costs a second or so of start-up per file. Files can share workers instead (isolate: false), but then
    // modules are imported once per worker and cached across files.
    // - electron: the main-process and preload tests stay isolated. They mock Electron per file (tests/setup/mockElectron.ts,
    //   or app.test.ts's own mock), load shell/main against that mock, and assert on its calls. In a shared worker the
    //   shell modules would stay bound to an earlier file's mock, or load the real Electron.
    // - shared: everything else mocks no modules, so it shares workers. tests/setup/setupTests.ts does what a shared
    //   worker would otherwise skip: it unmounts every test's components, since Testing Library registers its own cleanup
    //   only for the first file that imports it.
    // A test that starts mocking modules (vi.mock) belongs in tests/main or tests/preload, or needs isolating like them.
    projects: [
      {
        extends: true,
        test: {
          name: 'electron',
          include: ['tests/main/**/*.test.ts', 'tests/preload/**/*.test.ts'],
          isolate: true
        }
      },
      {
        extends: true,
        test: {
          name: 'shared',
          include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
          exclude: ['dist', 'node_modules', 'tests/main/**', 'tests/preload/**'],
          isolate: false,
          // The @tessera/ui fixture plugin the renderer tests load; only this project's tests use it
          globalSetup: ['./tests/setup/buildUiFixture.ts']
        }
      }
    ]
  }
})
