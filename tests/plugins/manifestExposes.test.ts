// @vitest-environment node
// Every renderer module a plugin contributes must also be exposed by its manifest.
//
// This exists because of a bug it would have caught: `exchange` contributed the export and CSV-mapping dialogs
// without adding them to `renderer.expose`, so the federation container had no such module. Nothing failed at
// build time, nothing failed in any unit test — the dialogs are tested by importing them directly — and the
// only symptom was a log line when a user actually opened one. A contribution naming a module that does not
// exist is a broken menu item, so it is worth failing a test rather than a user.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const PLUGINS = path.resolve(__dirname, '../../plugins')

interface Manifest {
  id: string
  renderer?: { entry?: string, expose?: Record<string, string> }
}

const pluginDirs = fs.readdirSync(PLUGINS, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => path.join(PLUGINS, entry.name))
  .filter(dir => fs.existsSync(path.join(dir, 'manifest.json')))

/** Every `module: './Something'` named in a plugin's source, which is how a contribution names a view or dialog. */
function contributedModules(dir: string): string[] {
  const found = new Set<string>()
  const walk = (at: string) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!/\.tsx?$/.test(entry.name)) continue
      const source = fs.readFileSync(full, 'utf8')
      for (const [, name] of source.matchAll(/\bmodule:\s*'(\.\/[A-Za-z0-9_]+)'/g)) found.add(name)
    }
  }
  const src = path.join(dir, 'src')
  if (fs.existsSync(src)) walk(src)
  return [...found].sort()
}

const manifestOf = (dir: string): Manifest =>
  JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))

describe('every plugin manifest', () => {
  it('finds the plugins to check, so an empty sweep cannot pass by accident', () => {
    expect(pluginDirs.length).toBeGreaterThan(5)
    expect(pluginDirs.map(d => path.basename(d))).toContain('exchange')
  })

  for (const dir of pluginDirs) {
    const name = path.basename(dir)

    it(`exposes every renderer module ${name} contributes`, () => {
      const manifest = manifestOf(dir)
      const exposed = Object.keys(manifest.renderer?.expose ?? {})
      const contributed = contributedModules(dir)

      const missing = contributed.filter(module => !exposed.includes(module))
      // Named in the message so the fix is obvious: add it to manifest.json's renderer.expose.
      expect({ plugin: name, missing }).toEqual({ plugin: name, missing: [] })
    })

    it(`points every exposed module of ${name} at a file that exists`, () => {
      const manifest = manifestOf(dir)
      for (const [module, file] of Object.entries(manifest.renderer?.expose ?? {})) {
        expect({ module, exists: fs.existsSync(path.join(dir, file)) })
          .toEqual({ module, exists: true })
      }
    })
  }
})

describe('the exchange plugin in particular', () => {
  it('exposes a module for every dialog and view it contributes', async () => {
    const { contributions } = await import('../../plugins/exchange/src/privileged/contributions')
    const manifest = manifestOf(path.join(PLUGINS, 'exchange'))
    const exposed = Object.keys(manifest.renderer?.expose ?? {})

    // Straight from the real contribution data rather than a regex over the source.
    const modules = contributions()
      .map(([, , impl]) => (impl as { module?: string }).module)
      .filter((module): module is string => typeof module === 'string')

    expect(modules.length).toBeGreaterThan(0)
    for (const module of modules) expect(exposed).toContain(module)
  })

  it('exposes the export and CSV-mapping dialogs, which is what this test was written for', () => {
    const manifest = manifestOf(path.join(PLUGINS, 'exchange'))
    const exposed = Object.keys(manifest.renderer?.expose ?? {})
    expect(exposed).toContain('./ExportDialog')
    expect(exposed).toContain('./CsvProfileDialog')
  })
})
