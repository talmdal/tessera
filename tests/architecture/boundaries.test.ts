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
})
