// scripts/build-renderer.mjs
//
// Builds one plugin's renderer remote with Vite and Module Federation. Run
// by build-plugins.mts as a separate Node process, one per plugin, because
// @module-federation/vite keeps state at module level (virtual modules are
// generated once per process, under the Vite root's node_modules in some
// versions), so a second plugin built in the same process is missing pieces
// and Rollup fails to resolve them. Plain JavaScript, so it needs no loader
// wherever the parent runs (ts-node, Vitest, or bare Node).
//
// Input: one JSON job on stdin:
//   { srcDir, id, entryOut, expose: { './Name': 'src/file.tsx' }, shared: string[], sharedVersion }
import fs from 'node:fs'
import path from 'node:path'
import { build } from 'vite'
import { federation } from '@module-federation/vite'

const job = JSON.parse(fs.readFileSync(0, 'utf8'))
const { srcDir, id, entryOut, expose, shared, sharedVersion } = job

const stub = '\0tessera-stub-entry'
await build({
  configFile: false,
  logLevel: 'warn',
  root: srcDir,
  plugins: [
    {
      name: 'tessera-stub-entry',
      resolveId: source => source === 'tessera-stub-entry' ? stub : null,
      load: source => source === stub ? 'export {}' : null
    },
    federation({
      name: id.replace(/[^A-Za-z0-9_$]/g, '_'),
      filename: path.basename(entryOut),
      exposes: Object.fromEntries(
        Object.entries(expose).map(([name, file]) => [name, path.resolve(srcDir, file)])
      ),
      shared: Object.fromEntries(
        shared.map(name => [name, { singleton: true, requiredVersion: sharedVersion, import: false }])
      ),
      dts: false
    })
  ],
  esbuild: { jsx: 'automatic' },
  build: {
    target: 'esnext',
    outDir: path.dirname(entryOut),
    emptyOutDir: true,
    minify: false,
    rollupOptions: {
      input: 'tessera-stub-entry',
      onwarn: (warning, warn) => {
        if (warning.code !== 'EMPTY_BUNDLE') warn(warning)
      }
    }
  }
})

// The stub entry leaves an empty chunk behind; only the remote's own files should ship.
const assets = path.join(path.dirname(entryOut), 'assets')
if (fs.existsSync(assets)) {
  for (const file of fs.readdirSync(assets)) {
    if (file.startsWith('_tessera-stub-entry')) fs.rmSync(path.join(assets, file))
  }
}
