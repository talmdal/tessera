import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { SHARED_MODULES, SHARED_MODULE_NAMES } from '../../shared/federation'
import { version as uiVersion } from '../../tessera-ui'

const repo = path.resolve(__dirname, '../..')
const read = (file: string) => JSON.parse(fs.readFileSync(path.join(repo, file), 'utf8'))

/** The package a specifier belongs to: 'react/jsx-runtime' is part of react. */
const packageOf = (name: string) => name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0]

describe('the federation share contract', () => {
  it('names React, Emotion, MUI and @tessera/ui', () => {
    expect(SHARED_MODULE_NAMES).toEqual(expect.arrayContaining([
      'react', 'react/jsx-runtime', 'react-dom', '@emotion/react', '@emotion/styled', '@mui/material', '@tessera/ui'
    ]))
  })

  it('requires a range the installed packages satisfy, so the shell can provide what plugins are built against', () => {
    for (const name of SHARED_MODULE_NAMES) {
      const pkg = packageOf(name)
      const installed = pkg === '@tessera/ui'
        ? read('tessera-ui/package.json').version
        : read(`node_modules/${pkg}/package.json`).version
      const [major, minor] = installed.split('.').map(Number)
      const range = SHARED_MODULES[name]
      expect(range, name).toMatch(/^\^\d+\.\d+\.\d+$/)
      const [wantMajor, wantMinor] = range.slice(1).split('.').map(Number)
      expect(major, `${name}: installed ${installed} does not satisfy ${range}`).toBe(wantMajor)
      expect(minor, `${name}: installed ${installed} does not satisfy ${range}`).toBeGreaterThanOrEqual(wantMinor)
    }
  })

  it('matches the version @tessera/ui announces to remotes', () => {
    expect(uiVersion).toBe(read('tessera-ui/package.json').version)
  })
})
