// Guards the hexagon: core/ and shared/ stay platform-free, and dependencies
// only point inwards (shell → core → shared).
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const repo = path.resolve(__dirname, '../..')

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    if (/.config.ts$/.test(entry.name)) return []
    return /\.tsx?$/.test(entry.name) ? [full] : []
  })
}

function importsOf(file: string) {
  const source = fs.readFileSync(file, 'utf8')
  const specifiers = [...source.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g)].map(m => m[1])
  return specifiers.map(spec => spec.startsWith('.') ? path.relative(repo, path.resolve(path.dirname(file), spec)) : spec)
}

/** The start of a path inside this repository, as `importsOf` reports a relative import. */
const REPO_DIRS = /^(core|shell|shared|plugins|packages|tessera-types|tessera-ui|tests|scripts)\//

const PLATFORM = /^(electron|node:|fs$|path$|os$|child_process$|url$)/

function violations(layer: string, forbidden: (spec: string) => boolean) {
  return sourceFiles(path.join(repo, layer)).flatMap(file =>
    importsOf(file).filter(forbidden).map(spec => `${path.relative(repo, file)} imports ${spec}`))
}

const inLayer = (spec: string, layer: string) =>
  spec.split(path.sep).join('/').startsWith(`${layer}/`) || spec.startsWith(`@${layer}/`)

const isUi = (spec: string) => spec === '@tessera/ui' || inLayer(spec, 'tessera-ui')
const isPrivateUi = (spec: string) => /^@(mui|emotion)\//.test(spec)

describe('architecture boundaries', () => {
  it('shared/ has no platform imports and depends on nothing else', () => {
    expect(violations('shared', spec => PLATFORM.test(spec) || inLayer(spec, 'core') || inLayer(spec, 'shell'))).toEqual([])
  })

  it('core/ has no platform imports and does not depend on shell/', () => {
    expect(violations('core', spec => PLATFORM.test(spec) || inLayer(spec, 'shell'))).toEqual([])
  })

  it('the renderer does not depend on core/ or main-process code', () => {
    expect(violations('shell/renderer', spec =>
      spec === 'electron' || inLayer(spec, 'core') || spec.split(path.sep).join('/').startsWith('shell/main'))).toEqual([])
  })

  it('only the renderer uses @tessera/ui: no React in the main process, core or shared', () => {
    expect([
      ...violations('shared', isUi),
      ...violations('core', isUi),
      ...violations('shell/main', isUi),
      ...violations('shell/preload', isUi)
    ]).toEqual([])
  })

  it('tessera-ui/ depends on React, MUI and @tessera/types only', () => {
    expect(violations('tessera-ui', spec =>
      PLATFORM.test(spec) || inLayer(spec, 'core') || inLayer(spec, 'shell') || inLayer(spec, 'shared'))).toEqual([])
  })

  it('plugins reach the framework only through @tessera/*, never core/, shell/ or shared/', () => {
    const plugins = path.join(repo, 'plugins')
    const found = fs.readdirSync(plugins, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && fs.existsSync(path.join(plugins, entry.name, 'src')))
      .flatMap(entry => sourceFiles(path.join(plugins, entry.name, 'src')).flatMap(file =>
        importsOf(file).filter(spec => {
          const normal = spec.split(path.sep).join('/')
          if (/^@(core|shell|shared|plugins|extensions)\//.test(normal)) return true
          // A relative import (already resolved against the repo) must stay inside this plugin.
          return REPO_DIRS.test(normal) && !normal.startsWith(`plugins/${entry.name}/`)
        }).map(spec => `${path.relative(repo, file)} imports ${spec}`)))
    expect(found).toEqual([])
  })

  it('@tessera/storage-kit is platform-free and depends on @tessera/types alone', () => {
    expect(violations('packages/storage-kit', spec => {
      const normal = spec.split(path.sep).join('/')
      if (PLATFORM.test(normal)) return true
      if (REPO_DIRS.test(normal)) return !normal.startsWith('packages/storage-kit/')
      return normal !== '@tessera/types'
    })).toEqual([])
  })

  it('the plugin API packages are platform-free contracts: @tessera/types and each other only', () => {
    const allowed: Record<string, string[]> = {
      'book-api': ['@tessera/types'],
      'accounts-api': ['@tessera/types', '@tessera/book-api']
    }
    const found = Object.entries(allowed).flatMap(([name, deps]) => violations(`packages/${name}`, spec => {
      const normal = spec.split(path.sep).join('/')
      if (PLATFORM.test(normal)) return true
      if (REPO_DIRS.test(normal)) return !normal.startsWith(`packages/${name}/`)
      return !deps.includes(normal)
    }))
    expect(found).toEqual([])
  })

  it('renderer code takes its colours from the theme, never from literals that ignore dark mode', () => {
    const plugins = path.join(repo, 'plugins')
    const pluginRenderers = fs.readdirSync(plugins, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && fs.existsSync(path.join(plugins, entry.name, 'src/renderer')))
      .flatMap(entry => sourceFiles(path.join(plugins, entry.name, 'src/renderer')))
    const files = [...sourceFiles(path.join(repo, 'shell/renderer')), ...pluginRenderers]
      .filter(file => !file.endsWith('iconGlyphs.ts'))   // SVG path data, not colours

    const hexLiteral = /['"`]#[0-9a-fA-F]{3,8}['"`]/
    expect(files.filter(file => hexLiteral.test(fs.readFileSync(file, 'utf8')))
      .map(file => path.relative(repo, file))).toEqual([])
  })

  it('plugin views reach MUI and Emotion only through @tessera/ui', () => {
    const plugins = path.join(repo, 'plugins')
    const sources = fs.readdirSync(plugins, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && fs.existsSync(path.join(plugins, entry.name, 'src')))
      .flatMap(entry => sourceFiles(path.join(plugins, entry.name, 'src')))
    expect(sources.flatMap(file => importsOf(file).filter(isPrivateUi).map(spec => `${path.relative(repo, file)} imports ${spec}`))).toEqual([])
  })
})
