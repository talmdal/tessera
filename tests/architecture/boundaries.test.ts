// Guards the hexagon: core/ and shared/ stay platform-free, and dependencies
// only point inwards (shell → core → shared). Also guards the UI rules in
// docs/material-ui-design.md: MUI is a renderer concern, shared modules are
// imported from their package root, and colours come from the theme.
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

const PLATFORM = /^(electron|node:|fs$|path$|os$|child_process$|url$)/

function violations(layer: string, forbidden: (spec: string) => boolean) {
  return sourceFiles(path.join(repo, layer)).flatMap(file =>
    importsOf(file).filter(forbidden).map(spec => `${path.relative(repo, file)} imports ${spec}`))
}

const inLayer = (spec: string, layer: string) =>
  spec.split(path.sep).join('/').startsWith(`${layer}/`) || spec.startsWith(`@${layer}/`)

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

  it('tessera-ui depends only on shared/ and the UI packages', () => {
    expect(violations('tessera-ui', spec =>
      PLATFORM.test(spec) || inLayer(spec, 'core') || inLayer(spec, 'shell') || inLayer(spec, 'tessera-types'))).toEqual([])
  })
})

describe('plugin boundaries', () => {
  // A plugin is written against the framework's public surface and nothing else: @tessera/types on either side,
  // the shared UI packages in its renderer, Node in its privileged half, its own files, and its own npm dependencies.
  const plugins = fs.readdirSync(path.join(repo, 'plugins'), { withFileTypes: true })
    .filter(d => d.isDirectory() && fs.existsSync(path.join(repo, 'plugins', d.name, 'manifest.json')))
    .map(d => d.name)
  const rootDependencies = Object.keys(JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).dependencies ?? {})
  const FRAMEWORK_INTERNALS = /^(electron|@module-federation\/|@core\/|@shared\/|@shell\/|@plugins\/)/
  const RENDERER_PACKAGES = /^(react|react-dom|react\/jsx-runtime|@mui\/material|@emotion\/react|@emotion\/styled|@tessera\/ui)$/
  const packageOf = (spec: string) => spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]

  const allowed = (plugin: string, file: string, spec: string) => {
    const renderer = file.split(path.sep).join('/').includes('/src/renderer/')
    if (FRAMEWORK_INTERNALS.test(spec)) return false
    if (spec === '@tessera/types') return true
    if (RENDERER_PACKAGES.test(spec)) return renderer
    if (/^node:/.test(spec) || /^(fs|path|os|url|crypto|util|events|stream)(\/|$)/.test(spec)) return !renderer
    if (/^[./]/.test(spec) || /^[A-Za-z]:/.test(spec) || spec.startsWith('plugins')) {
      // Resolved by importsOf to a repo-relative path: it must stay inside this plugin's folder.
      return spec.split(path.sep).join('/').startsWith(`plugins/${plugin}/`)
    }
    return rootDependencies.includes(packageOf(spec))    // lokijs and the like
  }

  it('plugins import only @tessera/types, @tessera/ui and the shared UI packages, Node, their own files and their own dependencies', () => {
    const found = plugins.flatMap(plugin => sourceFiles(path.join(repo, 'plugins', plugin, 'src')).flatMap(file =>
      importsOf(file).filter(spec => !allowed(plugin, file, spec)).map(spec => `${path.relative(repo, file)} imports ${spec}`)))
    expect(found).toEqual([])
  })

  it('covers every bundled plugin', () => {
    expect(plugins).toEqual(expect.arrayContaining(['app.state', 'storage.loki', 'test-layout', 'theme-halloween']))
  })
})

const UI_PACKAGE = /^(@mui\/|@emotion\/|@tessera\/ui)/

/** Renderer code: the shell's, the shared UI package's, and the views of bundled plugins. */
const RENDERER_LAYERS = ['shell/renderer', 'tessera-ui', ...fs.readdirSync(path.join(repo, 'plugins'), { withFileTypes: true })
  .filter(d => d.isDirectory() && fs.existsSync(path.join(repo, 'plugins', d.name, 'src/renderer')))
  .map(d => `plugins/${d.name}/src/renderer`)]

describe('UI boundaries', () => {
  it('MUI, Emotion and @tessera/ui are used only in the renderer', () => {
    for (const layer of ['core', 'shared', 'shell/main', 'shell/preload', 'tessera-types']) {
      expect(violations(layer, spec => UI_PACKAGE.test(spec)), layer).toEqual([])
    }
  })

  it('shared modules are imported from the package root, so a plugin gets the shell\'s copy', () => {
    // The host reads versions from package.json files; the icon registry imports glyphs by path.
    const allowed = (file: string, spec: string) =>
      spec.endsWith('/package.json') ||
      (spec.startsWith('@mui/icons-material/') && file.endsWith(path.join('tessera-ui', 'icons.ts')))
    // In a plugin every shared package counts; the shell is the provider, so its own React entry (react-dom/client) is fine.
    const UI_DEEP = /^(@mui\/material|@emotion\/react|@emotion\/styled|@tessera\/ui)\/./
    const REACT_DEEP = /^(react|react-dom)\/./
    const isDeep = (layer: string, spec: string) =>
      UI_DEEP.test(spec) || (layer.startsWith('plugins/') && REACT_DEEP.test(spec) && spec !== 'react/jsx-runtime')

    const deep = RENDERER_LAYERS.flatMap(layer => sourceFiles(path.join(repo, layer)).flatMap(file =>
      importsOf(file)
        .filter(spec => isDeep(layer, spec) && !allowed(file, spec))
        .map(spec => `${path.relative(repo, file)} imports ${spec}`)))
    expect(deep).toEqual([])
  })

  it('plugins never depend on @mui/icons-material; they use the shell\'s Icon or an SvgIcon of their own', () => {
    const plugins = RENDERER_LAYERS.filter(layer => layer.startsWith('plugins/'))
    expect(plugins.flatMap(layer => violations(layer, spec => spec.startsWith('@mui/icons-material')))).toEqual([])
  })

  it('renderer code has no colour literals: every colour comes from the theme', () => {
    // Themes are defined under shell/renderer/theme and in tessera-ui/tokens.ts; everywhere else reads them.
    const layers = RENDERER_LAYERS
    const exempt = (file: string) => /shell[\\/]renderer[\\/]theme[\\/]/.test(file) || file.endsWith(path.join('tessera-ui', 'tokens.ts'))
    const literal = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i
    const found = layers.flatMap(layer => sourceFiles(path.join(repo, layer))
      .filter(file => !exempt(file))
      .flatMap(file => fs.readFileSync(file, 'utf8').split('\n')
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => literal.test(line) && !line.trimStart().startsWith('//'))
        .map(({ i }) => `${path.relative(repo, file)}:${i + 1}`)))
    expect(found).toEqual([])
  })
})
