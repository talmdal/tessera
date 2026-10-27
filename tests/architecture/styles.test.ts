// Guards the style manager's one rule for shell CSS: colours come from the
// token catalogue (shared/theme/tokens.ts) and fonts from
// shared/theme/typography.ts, never from literals in a stylesheet. The
// built-in plugins' views follow the colour half of it, so they look right in
// every theme. See docs/style-manager-design.md, "Shell CSS rule".
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const repo = path.resolve(__dirname, '../..')

function files(dir: string, matches: (name: string) => boolean): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return files(full, matches)
    return matches(entry.name) ? [full] : []
  })
}

const NAMED_COLORS = ['white', 'black', 'red', 'green', 'blue', 'gray', 'grey', 'silver', 'orange', 'yellow', 'purple', 'navy', 'teal']

/** Declarations whose value is a literal rather than var(...). */
const LITERALS: { name: string, pattern: RegExp }[] = [
  { name: 'hex colour', pattern: /#[0-9a-f]{3,8}\b/i },
  { name: 'rgb()/hsl() colour', pattern: /\b(rgba?|hsla?)\s*\(/i },
  { name: 'named colour', pattern: new RegExp(`:\\s*[^;]*\\b(${NAMED_COLORS.join('|')})\\b`, 'i') },
  { name: 'font-family literal', pattern: /font-family\s*:(?!\s*(var\(|inherit\b))/ },
  { name: 'font-size literal', pattern: /font-size\s*:(?!\s*(var\(|inherit\b))/ },
  { name: 'font shorthand literal', pattern: /\bfont\s*:(?!\s*(var\(|inherit\b))/ }
]

/** Literals a view's inline styles must not use (named colours are too ambiguous to grep in TSX). */
const COLOR_LITERALS = LITERALS.filter(({ name }) => name === 'hex colour' || name === 'rgb()/hsl() colour')

function stripComments(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

function violations(paths: string[], rules: typeof LITERALS) {
  return paths.flatMap(file => {
    const lines = stripComments(fs.readFileSync(file, 'utf8')).split('\n')
    return lines.flatMap((line, index) =>
      rules.filter(({ pattern }) => pattern.test(line))
        .map(({ name }) => `${path.relative(repo, file)}:${index + 1} has a ${name}: ${line.trim()}`))
  })
}

describe('shell stylesheets', () => {
  it('take every colour and font from the theme variables, never from literals', () => {
    expect(violations(files(path.join(repo, 'shell/renderer'), name => name.endsWith('.css')), LITERALS)).toEqual([])
  })
})

describe("built-in plugins' views", () => {
  it('take every colour from the theme variables, never from literals', () => {
    const renderers = fs.readdirSync(path.join(repo, 'plugins'), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(repo, 'plugins', entry.name, 'src/renderer'))
    const sources = renderers.flatMap(dir => files(dir, name => /\.(tsx?|css)$/.test(name)))

    expect(sources.length).toBeGreaterThan(0)
    expect(violations(sources, COLOR_LITERALS)).toEqual([])
  })
})
