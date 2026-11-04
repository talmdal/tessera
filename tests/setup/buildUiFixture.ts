// Vitest global setup: builds the fixture plugin that uses @tessera/ui once, in plain Node, because esbuild
// can't run in the jsdom environment the renderer tests use. Tests read the entry URL with inject().
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { TestProject } from 'vitest/node'
import { buildPlugins } from '../../scripts/build-plugins.mts'

declare module 'vitest' {
  export interface ProvidedContext {
    /** URL of the built `themed` fixture plugin's remote entry. */
    themedRemoteEntry: string
  }
}

export default async function setup(project: TestProject) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-modules-ui-'))
  const [result] = await buildPlugins({ pluginsDir: path.resolve(__dirname, '../fixtures/ui-plugins'), outDir: out })
  if (!result?.ok) throw new Error(`Could not build the themed fixture plugin: ${result?.error}`)

  project.provide('themedRemoteEntry', pathToFileURL(path.join(out, 'themed/renderer/remoteEntry.js')).href)
  return () => fs.rmSync(out, { recursive: true, force: true })
}
