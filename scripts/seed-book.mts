// `npm run seed:book` — builds the “Household” test book and the bank files that go with it.
//
// The work is in scripts/seed/, which imports the plugins' own source through the `@tessera/*` aliases. Those
// aliases are a bundler's, not Node's, so this launcher bundles with esbuild first and then runs the result —
// the same arrangement scripts/build-plugins.mts uses to build a plugin.
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

const out = path.join(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tessera-seed-')), 'seed.mjs')

try {
  await esbuild.build({
    entryPoints: [path.resolve('scripts/seed/run.ts')],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    sourcemap: 'inline',
    packages: 'external',
    alias: aliases()
  })

  const { run } = await import(pathToFileURL(out).href) as { run(argv: string[]): Promise<void> }
  await run(process.argv.slice(2))
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
} finally {
  await fs.promises.rm(path.dirname(out), { recursive: true, force: true })
}
