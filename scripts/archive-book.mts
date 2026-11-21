// `npm run archive:book` — writes an archive of a book file with the real ArchiveWriter.
//
// The work is in scripts/archive/, which imports the plugins' own source through the `@tessera/*` aliases, so this
// launcher bundles with esbuild first and then runs the result, as scripts/seed-book.mts does. Like the bench, it
// bundles its npm dependencies too (LokiJS): the bundle runs from a temporary folder, outside node_modules.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import esbuild from 'esbuild'

const API_PACKAGES = ['book-api', 'accounts-api', 'recurring-api', 'exchange-api']

const aliases = (): Record<string, string> => ({
  '@tessera/types': path.resolve(process.cwd(), 'tessera-types/index.ts'),
  '@tessera/storage-kit': path.resolve(process.cwd(), 'packages/storage-kit/index.ts'),
  ...Object.fromEntries(API_PACKAGES.map(name =>
    [`@tessera/${name}`, path.resolve(process.cwd(), 'packages', name, 'index.ts')]))
})

const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tessera-archive-build-'))
const out = path.join(dir, 'archive.mjs')

try {
  await esbuild.build({
    entryPoints: [path.resolve('scripts/archive/run.ts')],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    sourcemap: 'inline',
    nodePaths: [path.resolve('node_modules')],
    // LokiJS is CommonJS and calls require(); an ES module bundle has none of its own
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    alias: aliases(),
    logLevel: 'warning'
  })

  const { run } = await import(pathToFileURL(out).href) as { run(argv: string[]): Promise<void> }
  await run(process.argv.slice(2))
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
} finally {
  await fs.promises.rm(dir, { recursive: true, force: true })
}
