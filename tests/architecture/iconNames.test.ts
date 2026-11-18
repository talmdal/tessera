// Every standard icon a bundled plugin names must be one the shell knows. An unknown name in a view or bar item
// contribution makes the shell drop the whole contribution, and in a component it draws a placeholder letter, so
// a typo or a name the set lacks fails quietly. This catches both before anyone has to notice.
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { isIconName } from '@tessera/types'

const plugins = path.resolve(__dirname, '../../plugins')

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(full)
    return /\.tsx?$/.test(entry.name) ? [full] : []
  })
}

/** `icon: 'Name'` in a contribution, and `<Icon name="Name"` in a component. File icons (`./…`) and registered ids (`plugin.name`) are left out. */
const NAMED = /(?:\bicon:\s*'([A-Za-z]+)'|<Icon\b[^>]*\bname="([A-Za-z]+)")/g

describe('icon names in bundled plugins', () => {
  it('are all in the shell’s standard set', () => {
    const unknown = sourceFiles(plugins).flatMap(file => {
      const source = fs.readFileSync(file, 'utf8')
      return [...source.matchAll(NAMED)]
        .map(match => match[1] ?? match[2])
        .filter(name => !isIconName(name))
        .map(name => `${path.relative(plugins, file)}: ${name}`)
    })
    expect(unknown).toEqual([])
  })
})
