// @vitest-environment node
// Plugins reach MUI only through @tessera/ui, which the shell provides as a federation singleton.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { buildPlugins } from '../../scripts/build-plugins.mts'
import { createTempModulesDir } from '../helpers/tempModules'

const fixtures = path.resolve(__dirname, '../fixtures/ui-plugins')

const renderedFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? renderedFiles(path.join(dir, entry.name)) : [path.join(dir, entry.name)])

describe('building a plugin that uses @tessera/ui', () => {
  it('shares @tessera/ui with the shell instead of bundling MUI or Emotion', { timeout: 60_000 }, async () => {
    const out = createTempModulesDir()

    const results = await buildPlugins({ pluginsDir: fixtures, outDir: out })

    expect(results).toEqual([{ id: 'themed', ok: true }])
    const renderer = path.join(out, 'themed/renderer')
    const code = renderedFiles(renderer).filter(f => f.endsWith('.js')).map(f => fs.readFileSync(f, 'utf8')).join('\n')
    expect(code).toContain('@tessera/ui')
    // No second copy of the theme context or the style cache for the plugin to render with
    expect(code).not.toMatch(/ThemeContext|@emotion|createTheme|emotion-element/)
    // The view itself is tiny: it reads its components from the shared module rather than carrying them
    const view = renderedFiles(path.join(renderer, 'assets')).find(f => path.basename(f).startsWith('ThemedView-'))!
    expect(fs.statSync(view).size).toBeLessThan(5_000)
  })

  it('shares @tessera/ui/charts with the shell too, instead of bundling MUI X Charts', { timeout: 60_000 }, async () => {
    const out = createTempModulesDir()

    await buildPlugins({ pluginsDir: fixtures, outDir: out })

    const renderer = path.join(out, 'themed/renderer')
    const code = renderedFiles(renderer).filter(f => f.endsWith('.js')).map(f => fs.readFileSync(f, 'utf8')).join('\n')
    expect(code).toContain('@tessera/ui/charts')
    // MUI X Charts is 423 KB minified: the plugin reads the shell's, which the shell loads when a view first asks. None
    // of its code is in the plugin's output
    expect(code).not.toMatch(/MuiBarChart|MuiPieChart|MuiChartsAxis|MuiChartsLegend|ChartsDataProvider|ChartsSurface|d3-scale|d3-shape|scaleBand/)
    // The view's chunk holds the view, and the federation plugin's wrapper for a module shared on first use, inlined:
    // 4.3 KB in one install, 5.3 KB in another (the wrapper is @module-federation/vite's, not ours, and varies with its
    // packages, which aren't locked). So the limit is there to catch MUI X bundled in, hundreds of KB, not to measure
    // the wrapper
    const view = renderedFiles(path.join(renderer, 'assets')).find(f => path.basename(f).startsWith('ChartView-'))!
    expect(fs.statSync(view).size).toBeLessThan(20_000)
  })

  it('takes the shared version ranges from package.json and tessera-ui, so they cannot drift from what the shell provides', { timeout: 60_000 }, async () => {
    const root = path.resolve(__dirname, '../..')
    const react = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).dependencies.react
    const ui = JSON.parse(fs.readFileSync(path.join(root, 'tessera-ui/package.json'), 'utf8')).version
    const out = createTempModulesDir()

    await buildPlugins({ pluginsDir: fixtures, outDir: out })

    // The federation plugin writes the shared modules' ranges to one chunk, whose name it has changed between
    // versions (`localSharedImportMap-…` in older ones, `_virtual_mf-localSharedImportMap…-…` in 1.23)
    const assets = path.join(out, 'themed/renderer/assets')
    const chunk = fs.readdirSync(assets).find(f => f.includes('localSharedImportMap'))
    expect(chunk, `no localSharedImportMap chunk in ${fs.readdirSync(assets).join(', ')}`).toBeDefined()
    const map = fs.readFileSync(path.join(assets, chunk!), 'utf8')
    const ranges = [...map.matchAll(/requiredVersion: "([^"]+)"/g)].map(m => m[1])
    expect(ranges.filter(r => r === react)).toHaveLength(3)        // react, react/jsx-runtime, react-dom
    expect(ranges.filter(r => r === `^${ui}`)).toHaveLength(2)      // @tessera/ui and @tessera/ui/charts
    expect(new Set(ranges)).toEqual(new Set([react, `^${ui}`]))
  })

  it('copies the public/ folder of a plugin next to its remote entry, where its icon files are served from', { timeout: 60_000 }, async () => {
    const out = createTempModulesDir()

    await buildPlugins({ pluginsDir: fixtures, outDir: out })

    // tessera-plugin://themed/logo.svg is served from the folder holding the remote entry
    const logo = path.join(out, 'themed/renderer/logo.svg')
    expect(fs.existsSync(logo)).toBe(true)
    expect(fs.readFileSync(logo, 'utf8')).toContain('<svg')
  })

  it('refuses a plugin that imports MUI or Emotion directly', { timeout: 60_000 }, async () => {
    for (const specifier of ['@mui/material', '@mui/material/Button', '@emotion/react']) {
      const src = createTempModulesDir()
      const plugin = path.join(src, 'themed')
      fs.cpSync(path.join(fixtures, 'themed'), plugin, { recursive: true })
      fs.writeFileSync(path.join(plugin, 'src/renderer/ThemedView.tsx'),
        `import * as direct from '${specifier}'\nexport default function V() { return <p>{String(direct)}</p> }\n`)

      const [result] = await buildPlugins({ pluginsDir: src, outDir: createTempModulesDir() })

      expect(result).toMatchObject({ ok: false, error: expect.stringContaining(`"${specifier}" is the shell's private dependency`) })
      expect(result.error).toContain('@tessera/ui')
    }
  })
})
